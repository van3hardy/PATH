# Gmail Inbox Reply Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `gmail-scan-replies.mjs`, a read-only Gmail Inbox scanner that turns recent employer replies into `data/reply-candidates.json` entries in the exact shape `reply-watch.mjs` consumes — closing the `#1583` gap documented in `paste-reply.mjs`.

**Architecture:** A standalone root script composed of small pure functions (OAuth token exchange, list query, blocklist resolution, message→candidate parsing) plus a `scanReplies()` orchestrator with an injected `write` seam for `--dry-run` testability. It reuses `paste-reply.mjs`'s exported `appendCandidate` (atomic write-then-rename), `plugins/gmail/_helpers.mjs` (`getMessageBody`, `parseRoleAtCompany`), `plugins/_engine.mjs`'s `loadPluginConfig`, and the OAuth refresh pattern from `transports/gmail-send.mjs`. Reads credentials from `.env` (dotenv, optional). No package deps beyond what the repo already uses.

**Tech Stack:** Node ESM (`node:test` for tests), raw `fetch`, Gmail REST API (`gmail.googleapis.com`), `js-yaml` (lazy, via existing engine loader), `dotenv` (lazy, optional).

## Global Constraints

- **No real tracker mutations from the scanner** — imports no `tracker-*` module, never touches `data/applications.md`.
- **Candidate shape is fixed**: `{ message_id, from, subject, body_snippet, signal: null }` — exactly what `reply-watch.mjs` consumes.
- **Idempotency**: message id membership checked against both `data/reply-candidates.json` and `data/gmail-state.json` cursor.
- **Per-message resilience**: a single bad detail fetch is skipped and logged, never fatal.
- **`--dry-run`** lists what it would append, touching nothing (no candidates write, no state write).
- **No DMARC gate on replies** — accepts everything in the window; blocklist + reply-watch's Noise classifier + the human review prompt sort it. Note why in code.
- **No integration test against real Gmail** — always injected `fetchFn`.
- **Zero new package dependencies**.
- Version floors / language: plain ESM, `node:test` + `node:assert/strict`, Node's built-in `fetch`.

---

### Task 1: Pure helpers — blocklist, list query, message parsing

**Files:**
- Create: `gmail-scan-replies.mjs`
- Test: `tests/gmail-scan-replies.test.mjs`

**Interfaces:**
- Consumes: `getMessageBody(payload)`, `parseRoleAtCompany(subject)` from `plugins/gmail/_helpers.mjs` (existing exports).
- Produces:
  - `buildListQuery({ days })` → `string` — `in:inbox newer_than:{days}d`
  - `resolveBlocklist({ cfg })` → `Set<string>` — inline defaults ∪ `cfg.plugins?.['gmail-replies']?.blocklist_senders`; domains lowercased, `@`-prefixed bare addresses normalized to their domain.
  - `isBlocklisted(from, blocklist)` → `boolean`
  - `parseMessage({ id, payload })` → `{ message_id, from, subject, body_snippet, signal: null }`

- [ ] **Step 1: Write the failing tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildListQuery, resolveBlocklist, isBlocklisted, parseMessage,
} from '../gmail-scan-replies.mjs';

test('buildListQuery renders in:inbox newer_than:Nd', () => {
  assert.equal(buildListQuery({ days: 7 }), 'in:inbox newer_than:7d');
  assert.equal(buildListQuery({ days: 30 }), 'in:inbox newer_than:30d');
});

test('resolveBlocklist unions inline defaults with cfg blocklist_senders', () => {
  const cfg = { plugins: { 'gmail-replies': { blocklist_senders: ['Alerts.Example.com'] } } };
  const set = resolveBlocklist({ cfg });
  assert.ok(set.size >= 1, 'inline defaults present');
  assert.ok(set.has('alerts.example.com'), 'config domain lowercased and merged');
});

test('isBlocklisted matches domain and bare-address sender', () => {
  const blocklist = new Set(['alerts.example.com']);
  assert.equal(isBlocklisted('alerts@example.com', blocklist), true);
  assert.equal(isBlocklisted('recruiter@example.com', blocklist), false);
});

test('parseMessage extracts headers + body and sets signal null', () => {
  const payload = {
    headers: [
      { name: 'From', value: 'recruiter@example.com' },
      { name: 'Subject', value: 'Interview invitation' },
    ],
    parts: [{
      body: { data: Buffer.from('Your first-round interview is…').toString('base64url') },
    }],
  };
  const cand = parseMessage({ id: 'abc123', payload });
  assert.deepEqual(cand, {
    message_id: 'abc123',
    from: 'recruiter@example.com',
    subject: 'Interview invitation',
    body_snippet: 'Your first-round interview is…',
    signal: null,
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gmail-scan-replies.test.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` / `Cannot find module '../gmail-scan-replies.mjs'`.

- [ ] **Step 3: Write the minimal implementation**

Create `gmail-scan-replies.mjs`:

```js
#!/usr/bin/env node
// @ts-check
// gmail-scan-replies.mjs — read-only Inbox scanner feeding reply-watch.mjs (#1583).
//
// Turns recent employer replies in the Gmail Inbox into data/reply-candidates.json
// entries ({ message_id, from, subject, body_snippet, signal: null }) — the exact
// shape reply-watch.mjs consumes. Classification stays in reply-watch.mjs; this
// script never runs it, never imports tracker-*, and never touches
// data/applications.md (preserves the HUMAN_REVIEW guarantee).
//
// Deliberately NO DMARC fail-closed gate (unlike plugins/gmail): legitimate
// employer replies often come from domains that aren't DMARC-aligned, and
// rejecting them would silently starve the pipeline. Blocklist + reply-watch's
// Noise classifier + the human review prompt are the sorting layer instead.
//
// Usage:
//   node gmail-scan-replies.mjs [--days N] [--dry-run]
// Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (same three as
// gmail-send / plugins/gmail). Config (optional): config/plugins.yml →
// plugins.gmail-replies.{days_back, blocklist_senders}.

import { getMessageBody, parseRoleAtCompany } from './plugins/gmail/_helpers.mjs';

/** Inline defaults; config blocklist_senders is additive on top of these. */
const DEFAULT_BLOCKLIST = new Set([
  'alerts.zhaopin.com',
  'job-alerts.linkedin.com',
  'notification.linkedin.com',
  'jobs-list-manager.linkedin.com',
  'notifications@commonapp.org',
]);

/**
 * Build the Gmail list query string.
 * @param {{ days: number }} o
 * @returns {string}
 */
export function buildListQuery({ days }) {
  return `in:inbox newer_than:${days}d`;
}

/**
 * Resolve the blocklist: inline defaults ∪ config overlay. Domains are
 * lowercased; a bare address ("foo@bar.com") is normalized to its domain.
 * @param {{ cfg?: any }} o
 * @returns {Set<string>}
 */
export function resolveBlocklist({ cfg }) {
  const out = new Set(DEFAULT_BLOCKLIST);
  const extra = cfg?.plugins?.['gmail-replies']?.blocklist_senders;
  if (Array.isArray(extra)) {
    for (const raw of extra) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      out.add(normalizeSender(raw));
    }
  }
  return out;
}

/** Normalize an email address or bare domain to a lowercased domain. */
function normalizeSender(value) {
  const v = value.trim().toLowerCase();
  const at = v.lastIndexOf('@');
  return at === -1 ? v : v.slice(at + 1);
}

/**
 * Is the sender (email address or bare domain) on the blocklist?
 * @param {string} from
 * @param {Set<string>} blocklist
 * @returns {boolean}
 */
export function isBlocklisted(from, blocklist) {
  if (!from) return false;
  return blocklist.has(normalizeSender(from));
}

/**
 * Extract a reply-watch candidate from a Gmail full-detail payload.
 * @param {{ id: string, payload: any }} o
 * @returns {{ message_id: string, from: string, subject: string, body_snippet: string, signal: null }}
 */
export function parseMessage({ id, payload }) {
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const pick = (name) => headers.find((h) => h?.name?.toLowerCase() === name)?.value ?? '';
  const from = pick('from');
  const subject = pick('subject');
  const body = getMessageBody(payload);
  const seed = parseRoleAtCompany(subject);
  return {
    message_id: id,
    from,
    subject,
    body_snippet: body || (seed ? `${seed.role} ${seed.company}`.trim() : ''),
    signal: null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/gmail-scan-replies.test.mjs`
Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
git add gmail-scan-replies.mjs tests/gmail-scan-replies.test.mjs
git commit -m "feat(gmail-replies): pure helpers — list query, blocklist, message parsing"
```

---

### Task 2: OAuth token exchange + fetch helpers

**Files:**
- Modify: `gmail-scan-replies.mjs`
- Test: `tests/gmail-scan-replies.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `getAccessToken({ clientId, clientSecret, refreshToken }, fetchFn)` → `Promise<string>`; throws `codedError('OAUTH_FAILED', cause)` on any non-2xx or missing token.
  - `fetchMessageList({ token, query, pageToken, fetchFn })` → `{ messages: Array<{id:string}>, nextPageToken?: string }`
  - `fetchMessageDetail({ token, id, fetchFn })` → `Promise<any>` (full payload)

- [ ] **Step 1: Write the failing tests**

```js
test('getAccessToken exchanges the refresh grant and returns the access token', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok-9' }) };
  };
  const token = await getAccessToken(
    { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok' }, fetchFn
  );
  assert.equal(token, 'tok-9');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(calls[0].init.body.toString(), /client_id=cid/);
  assert.match(calls[0].init.body.toString(), /refresh_token=rtok/);
  assert.match(calls[0].init.body.toString(), /grant_type=refresh_token/);
});

test('getAccessToken rejects on token-refresh failure', async () => {
  const fetchFn = async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => 'bad' });
  await assert.rejects(
    getAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, fetchFn),
    (err) => err.message === 'OAUTH_FAILED'
  );
});

test('fetchMessageList passes query + pageToken and returns nextPageToken', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return {
      ok: true, status: 200,
      json: async () => ({ messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'pg2' }),
    };
  };
  const out = await fetchMessageList({ token: 't', query: 'in:inbox newer_than:7d', pageToken: null, fetchFn });
  assert.deepEqual(out.messages, [{ id: 'm1' }, { id: 'm2' }]);
  assert.equal(out.nextPageToken, 'pg2');
  assert.ok(calls[0].includes('q=in%3Ainbox%20newer_than%3A7d'));
  assert.ok(calls[0].includes('pageToken=pg2') === false);
  assert.ok(calls[0].startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages'));
});

test('fetchMessageDetail GETs the full message payload', async () => {
  const fetchFn = async (url) => {
    assert.ok(url.includes('/messages/m1?format=full'));
    return { ok: true, status: 200, json: async () => ({ id: 'm1', payload: {} }) };
  };
  const detail = await fetchMessageDetail({ token: 't', id: 'm1', fetchFn });
  assert.equal(detail.id, 'm1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gmail-scan-replies.test.mjs`
Expected: FAIL — `getAccessToken is not a function`.

- [ ] **Step 3: Implement**

Append to `gmail-scan-replies.mjs`:

```js
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 * Mirrors transports/gmail-send.mjs and plugins/gmail/index.mjs.
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} creds
 * @param {(url: string, init?: any) => Promise<any>} fetchFn
 * @returns {Promise<string>}
 */
export async function getAccessToken({ clientId, clientSecret, refreshToken }, fetchFn = globalThis.fetch) {
  let response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch (cause) {
    throw codedError('OAUTH_FAILED', cause);
  }
  if (!response.ok) throw codedError('OAUTH_FAILED');
  const data = await response.json().catch(() => ({}));
  if (!data.access_token) throw codedError('OAUTH_FAILED');
  return data.access_token;
}

/**
 * GET the message id list for a query, one page.
 * @param {{ token: string, query: string, pageToken: string | null, fetchFn: any }} o
 * @returns {Promise<{ messages: Array<{ id: string }>, nextPageToken?: string }>}
 */
export async function fetchMessageList({ token, query, pageToken, fetchFn = globalThis.fetch }) {
  let url = `${GMAIL_API}/messages?q=${encodeURIComponent(query)}`;
  if (pageToken) url += `&pageToken=${pageToken}`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw codedError('LIST_FAILED');
  return res.json();
}

/**
 * GET the full detail payload for a single message id.
 * @param {{ token: string, id: string, fetchFn: any }} o
 * @returns {Promise<any>}
 */
export async function fetchMessageDetail({ token, id, fetchFn = globalThis.fetch }) {
  const res = await fetchFn(`${GMAIL_API}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw codedError('DETAIL_FAILED');
  return res.json();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/gmail-scan-replies.test.mjs`
Expected: ALL PASS (previous 4 + new 4 = 8).

- [ ] **Step 5: Commit**

```bash
git add gmail-scan-replies.mjs tests/gmail-scan-replies.test.mjs
git commit -m "feat(gmail-replies): OAuth token exchange + Gmail list/detail fetch helpers"
```

---

### Task 3: `scanReplies()` orchestrator with the `write` seam

**Files:**
- Modify: `gmail-scan-replies.mjs`
- Test: `tests/gmail-scan-replies.test.mjs`

**Interfaces:**
- Consumes: `getAccessToken`, `fetchMessageList`, `fetchMessageDetail`, `buildListQuery`, `resolveBlocklist`, `isBlocklisted`, `parseMessage` (all from Tasks 1–2).
- Produces:
  - `scanReplies({ credentials, cfg, days, existingIds, stateCursor, fetchFn, writeCandidate, writeState })` → `Promise<{ scanned: number, appended: string[], skippedSeen: number, skippedBlocklisted: number, skippedErrored: number }>`
  - `existingIdsFromCandidates(candidates)` → `Set<string>`

- [ ] **Step 1: Write the failing tests**

```js
test('scanReplies appends only unseen, non-blocklisted messages', async () => {
  const blocklist = new Set(['alerts.example.com']);
  const detailPayloads = {
    m1: { id: 'm1', payload: { headers: [{ name: 'From', value: 'r1@example.com' }, { name: 'Subject', value: 'Interview' }], parts: [{ body: { data: Buffer.from('hi').toString('base64url') } }] } },
    m2: { id: 'm2', payload: { headers: [{ name: 'From', value: 'alerts@example.com' }, { name: 'Subject', value: 'Job alert' }], parts: [] } },
  };
  const fetchFn = async (url) => {
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 't' }) };
    if (url.includes('/messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }) };
    const id = /\/messages\/([^?]+)\?format=full/.exec(url)?.[1];
    if (id === 'm3') return { ok: true, json: async () => ({ id: 'm3', payload: { headers: [{ name: 'From', value: 'seen@example.com' }], parts: [] } }) };
    return { ok: true, json: async () => detailPayloads[id] };
  };
  const writes = [];
  const result = await scanReplies({
    credentials: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
    cfg: {},
    days: 7,
    existingIds: new Set(['m3']),   // m3 already a candidate → skipped
    stateCursor: new Set(),
    fetchFn,
    writeCandidate: async (cand) => { writes.push(cand); },
    writeState: async () => {},
  });
  assert.deepEqual(result.appended, ['m1']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].message_id, 'm1');
  assert.equal(result.skippedSeen, 1);       // m3
  assert.equal(result.skippedBlocklisted, 1); // m2
  assert.equal(result.skippedErrored, 0);
});

test('scanReplies survives a single bad detail fetch', async () => {
  const fetchFn = async (url) => {
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 't' }) };
    if (url.includes('/messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'bad' }] }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const writes = [];
  const result = await scanReplies({
    credentials: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
    cfg: {}, days: 7, existingIds: new Set(), stateCursor: new Set(),
    fetchFn,
    writeCandidate: async (cand) => writes.push(cand),
    writeState: async () => {},
  });
  assert.equal(result.skippedErrored, 1);
  assert.equal(writes.length, 0);
});

test('existingIdsFromCandidates extracts message_ids from candidate arrays', () => {
  const ids = existingIdsFromCandidates([
    { message_id: 'a' }, { message_id: 'b' },
  ]);
  assert.deepEqual([...ids].sort(), ['a', 'b']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gmail-scan-replies.test.mjs`
Expected: FAIL — `scanReplies is not a function`.

- [ ] **Step 3: Implement**

Append to `gmail-scan-replies.mjs`:

```js
/**
 * Extract the set of already-seen Gmail message ids from a candidates array.
 * @param {Array<{ message_id?: string }>} candidates
 * @returns {Set<string>}
 */
export function existingIdsFromCandidates(candidates) {
  return new Set((candidates || []).map((c) => c.message_id).filter(Boolean));
}

/**
 * Scan the Inbox window and hand every new, non-blocklisted message to
 * writeCandidate as a reply-watch candidate. Idempotent: messages already in
 * the candidates file (existingIds) or the shared state cursor are skipped.
 * writeCandidate / writeState are injected so --dry-run can make them no-ops
 * and tests can capture them without touching the file system.
 *
 * @param {object} o
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} o.credentials
 * @param {any} o.cfg
 * @param {number} o.days
 * @param {Set<string>} o.existingIds
 * @param {Set<string>} o.stateCursor
 * @param {any} o.fetchFn
 * @param {(cand: any) => Promise<void>} o.writeCandidate
 * @param {(ids: Set<string>) => Promise<void>} o.writeState
 * @returns {Promise<{ scanned: number, appended: string[], skippedSeen: number, skippedBlocklisted: number, skippedErrored: number }>}
 */
export async function scanReplies({
  credentials, cfg, days, existingIds, stateCursor, fetchFn = globalThis.fetch,
  writeCandidate, writeState,
}) {
  const blocklist = resolveBlocklist({ cfg });
  const token = await getAccessToken(credentials, fetchFn);
  const query = buildListQuery({ days });
  const appended = [];
  let skippedSeen = 0;
  let skippedBlocklisted = 0;
  let skippedErrored = 0;
  let scanned = 0;

  let pageToken = null;
  do {
    const page = await fetchMessageList({ token, query, pageToken, fetchFn });
    for (const entry of page.messages || []) {
      const id = entry.id;
      if (existingIds.has(id) || stateCursor.has(id)) { skippedSeen++; continue; }
      let detail;
      try {
        detail = await fetchMessageDetail({ token, id, fetchFn });
      } catch (err) {
        skippedErrored++;
        console.warn(`gmail-replies: failed to fetch message ${id} — ${err.message}`);
        continue;
      }
      const candidate = parseMessage({ id, payload: detail?.payload });
      if (isBlocklisted(candidate.from, blocklist)) { skippedBlocklisted++; continue; }
      await writeCandidate(candidate);
      appended.push(id);
      scanned++;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  await writeState(new Set([...stateCursor, ...appended]));
  return { scanned, appended, skippedSeen, skippedBlocklisted, skippedErrored };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/gmail-scan-replies.test.mjs`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add gmail-scan-replies.mjs tests/gmail-scan-replies.test.mjs
git commit -m "feat(gmail-replies): scanReplies orchestrator with injectable write seam"
```

---

### Task 4: CLI wiring — args, dotenv, config, file writes, dry-run

**Files:**
- Modify: `gmail-scan-replies.mjs`
- Test: `tests/gmail-scan-replies.test.mjs` (CLI-level via subprocess; plus a pure `parseArgs` helper test)

**Interfaces:**
- Consumes: `scanReplies` (Task 3), `loadPluginConfig` from `plugins/_engine.mjs`, `appendCandidate` from `paste-reply.mjs`.
- Produces:
  - `parseArgs(argv)` → `{ days: number, dryRun: boolean }`
  - `main()` (guarded: runs only when executed directly, like `paste-reply.mjs`)

- [ ] **Step 1: Write the failing tests**

```js
test('parseArgs defaults and --days/--dry-run overrides', () => {
  assert.deepEqual(parseArgs([]), { days: 7, dryRun: false });
  assert.deepEqual(parseArgs(['--days', '30']), { days: 30, dryRun: false });
  assert.deepEqual(parseArgs(['--dry-run']), { days: 7, dryRun: true });
  assert.deepEqual(parseArgs(['--days', '3', '--dry-run']), { days: 3, dryRun: true });
});
```

And a CLI integration test using `spawnSync` (mirroring `tests/path-safety/dispatch-send.test.mjs` conventions):

```js
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gmail-scan-replies.mjs', import.meta.url));

test('CLI exits non-zero with a clear message when GMAIL_* env is missing', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf-8',
    env: { ...process.env, GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REFRESH_TOKEN: '' },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /GMAIL_/);
});

test('CLI --help prints usage and exits 0', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf-8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /gmail-scan-replies\.mjs/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gmail-scan-replies.test.mjs`
Expected: FAIL — `parseArgs is not a function`, CLI exits 1 / no `--help` handling.

- [ ] **Step 3: Implement the CLI**

Append to `gmail-scan-replies.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES_PATH = process.env.CAREER_OPS_REPLY_CANDIDATES
  || path.join(__dirname, 'data', 'reply-candidates.json');
const STATE_PATH = path.join(__dirname, 'data', 'gmail-state.json');

/**
 * Parse CLI args: [--days N] [--dry-run]. Defaults: days 7, no dry-run.
 * @param {string[]} argv
 * @returns {{ days: number, dryRun: boolean }}
 */
export function parseArgs(argv) {
  const daysIdx = argv.indexOf('--days');
  const days = daysIdx !== -1 && argv[daysIdx + 1]
    ? Number(argv[daysIdx + 1])
    : 7;
  return { days: Number.isInteger(days) && days > 0 ? days : 7, dryRun: argv.includes('--dry-run') };
}

/** Lazy dotenv load; mirrors scripts/path-dispatch.mjs. Optional package. */
let dotenvLoaded = false;
async function loadDotenvOnce() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    const { config } = await import('dotenv');
    config();
  } catch { /* dotenv optional — ambient process.env only */ }
}

function readCandidatesFile() {
  if (!fs.existsSync(CANDIDATES_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readStateFile() {
  if (!fs.existsSync(STATE_PATH)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    return new Set(parsed.processed_message_ids || []);
  } catch {
    return new Set();
  }
}

function saveStateFile(ids) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ processed_message_ids: [...ids] }, null, 2), 'utf-8');
}

function printHelp() {
  console.log(`gmail-scan-replies.mjs — read-only Inbox scanner feeding reply-watch.mjs (#1583)

Usage:
  node gmail-scan-replies.mjs [--days N] [--dry-run]
  node gmail-scan-replies.mjs --help

Scans in:inbox newer_than:Nd, skips blocklisted job-alert senders and messages
already present in data/reply-candidates.json or the shared data/gmail-state.json
cursor, and appends the rest as reply-watch candidates (signal stays null).

--dry-run  lists what would be appended without writing anything.
--days N   look back N days (default 7; config plugins.gmail-replies.days_back overrides).

Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (same three as
gmail-send / plugins/gmail). Next step after scanning: node reply-watch.mjs`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { printHelp(); return; }

  await loadDotenvOnce();
  const { days: cliDays, dryRun } = parseArgs(args);

  const { loadPluginConfig } = await import('./plugins/_engine.mjs');
  const cfg = await loadPluginConfig(__dirname);
  const cfgBlock = cfg?.plugins?.['gmail-replies'] || {};
  const days = Number.isInteger(cfgBlock.days_back) && cfgBlock.days_back > 0 ? cfgBlock.days_back : cliDays;

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    console.error('gmail-replies: missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN in .env');
    process.exit(1);
  }

  const existingIds = existingIdsFromCandidates(readCandidatesFile());
  const stateCursor = readStateFile();

  const { appendCandidate } = await import(pathToFileURL(path.join(__dirname, 'paste-reply.mjs')).href);

  const writeCandidate = dryRun
    ? async () => {}
    : async (cand) => { appendCandidate(cand, CANDIDATES_PATH); };
  const writeState = dryRun
    ? async () => {}
    : saveStateFile;

  const result = await scanReplies({
    credentials: { clientId, clientSecret, refreshToken },
    cfg, days, existingIds, stateCursor,
    writeCandidate, writeState,
  });

  const verb = dryRun ? 'would append' : 'appended';
  console.log(`\n${verb} ${result.appended.length} new reply candidate(s).`);
  console.log(`scanned: ${result.scanned}, skipped already-seen: ${result.skippedSeen}, skipped blocklisted: ${result.skippedBlocklisted}, skipped errored: ${result.skippedErrored}`);
  if (dryRun && result.appended.length > 0) {
    console.log('Dry run — no files were written. Re-run without --dry-run to append.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/gmail-scan-replies.test.mjs`
Expected: ALL PASS.

- [ ] **Step 5: Verify the full discovered suite still passes**

Run: `node test-all.mjs --only gmail-scan-replies`
Expected: `gmail-scan-replies.test.mjs — node:test suite passed (N tests)`.

- [ ] **Step 6: Commit**

```bash
git add gmail-scan-replies.mjs tests/gmail-scan-replies.test.mjs
git commit -m "feat(gmail-replies): CLI — args, env, config, file writes, dry-run"
```

---

### Task 5: Docs — config example + scanner reference

**Files:**
- Modify: `config/plugins.example.yml`
- Create: `docs/path/gmail-reply-scanner.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the config example block**

Append to `config/plugins.example.yml` after the existing `gmail:` block:

```yaml
  # ── gmail-replies (read-only Inbox → reply-watch) ── standalone scanner #1583.
  # Needs GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN in .env.
  # Run via `node gmail-scan-replies.mjs [--days N] [--dry-run]`.
  # NOT a plugin — this block only carries settings; the script is invoked directly.
  gmail-replies:
    enabled: false
    # days_back: 7            # overrides --days
    # blocklist_senders: []   # extra job-alert senders to skip (domains or addresses)
```

- [ ] **Step 2: Write the scanner reference doc**

Create `docs/path/gmail-reply-scanner.md` with: purpose (one paragraph, closes `#1583`), usage (`node gmail-scan-replies.mjs [--days N] [--dry-run]`), env vars (the three `GMAIL_*`), config (`config/plugins.yml` → `plugins.gmail-replies`), data flow (Inbox → filter → `data/reply-candidates.json`, shared `data/gmail-state.json` cursor), safety notes (no tracker writes, no DMARC gate by design, idempotency), and the next step (`node reply-watch.mjs`).

- [ ] **Step 3: Verify the mode/example config reference is syntactically valid**

Run: `node test-all.mjs --only plugins`
Expected: PASS — the example config stays parseable (any existing config-integrity assertions).

- [ ] **Step 4: Commit**

```bash
git add config/plugins.example.yml docs/path/gmail-reply-scanner.md
git commit -m "docs(gmail-replies): config example block + scanner reference"
```

---

### Task 6: Full-suite verification + gap-review update

**Files:**
- Modify: `docs/path/gap-review.md` (§9 row and §6 #cross-cutting tail)

**Interfaces:** none.

- [ ] **Step 1: Run the full test suite**

Run: `node test-all.mjs`
Expected: All suites pass, no regressions (the new `tests/gmail-scan-replies.test.mjs` appears in the discovered list).

- [ ] **Step 2: Update the gap review**

In `docs/path/gap-review.md`, update the §9 row status from ⚠️ to ✅ (or note the scanner as shipped, keeping the row honest) and adjust the §6 cross-cutting item that says the reply feed is "manual only". Reference `gmail-scan-replies.mjs` and the design/plan docs.

- [ ] **Step 3: Run lint/typecheck if the repo provides it**

Run: `node doctor.mjs` (if it exists) to confirm no new env/key complaints beyond the expected `GMAIL_*` note; skip any check that requires live credentials.

- [ ] **Step 4: Commit**

```bash
git add docs/path/gap-review.md
git commit -m "docs(gap-review): mark reply feed scanner shipped (§9)"
```

---

## Self-review

- **Spec coverage:** every spec section maps to a task — architecture (Tasks 1–3), config/env (Tasks 4–5), safety properties (Tasks 3–4: idempotency, per-message resilience, dry-run, no tracker path, fails-soft blocklist), candidate shape (Task 1), testing (Tasks 1–4), risks (DMARC relaxed — noted in Task 1 code header; shared state cursor — Task 3 `scanReplies` union; OAuth duplication — accepted).
- **Placeholder scan:** no TBD/TODO; every step has concrete code or commands.
- **Type consistency:** `parseMessage` shape matches `appendCandidate`'s expectations and `reply-watch.mjs`'s `classifyReply` input (`message_id/from/subject/body_snippet/signal`); `scanReplies` result fields match the Task 3 test assertions; `parseArgs` return shape matches the Task 4 test.
- **Config key naming:** spec and Tasks use `plugins['gmail-replies'].days_back` / `blocklist_senders`, consistent with `loadPluginConfig` → `cfg.plugins.<id>` (bracket access for the hyphenated id) and the `plugins.example.yml` block in Task 5.
- **`appendCandidate` import:** uses `pathToFileURL(...).href` dynamic import, matching how `paste-reply.mjs` and other repo scripts are imported for direct-use; avoids Node ESM extension issues.
