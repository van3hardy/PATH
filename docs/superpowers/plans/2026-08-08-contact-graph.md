# Contact Ledger — People Database for Duplicate-Outreach Prevention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, append-only people ledger (`data/contacts.jsonl`) that dedups outreach **by person**, not by packet. A new pure `path-safety/contacts.mjs` module (last-line-wins JSONL, email-keyed `contactId`) is wired into the dispatch gate (`--contacts` flag → `BLOCKED_ALREADY_CONTACTED`), the draft summary (advisory prior-contact line), and a one-time backfill seed from the existing tracker/outbox data.

**Architecture:** `contacts.mjs` mirrors `audit-ledger.mjs` discipline: pure fs + crypto, append-only writes, fail-loud corrupt lines, missing file → empty store. `scripts/path-dispatch.mjs` gains an optional `--contacts <path>` flag (empty store when absent/missing → behavior unchanged) plus an opt-in write-back of the recipient on a *successful* `--send`. `recruiter-workflow.mjs` reads the ledger pre-draft (advisory warning line in the summary). `scripts/contacts-backfill.mjs` is a one-time idempotent seed from `data/applications.md` notes + outbox/dispatch recipients.

**Tech Stack:** Node.js (ESM), `node:test` + `spawnSync` (existing test conventions), `node:crypto`, existing `tracker-parse.mjs` / `followup-cadence.mjs` parsers. No new packages.

## Global Constraints

- `contacts.mjs` ships **fs + crypto only**; no other imports; no comments beyond what the code explains; no mutation exports beyond appends (a `loadContacts`+`findPerson`+`upsert` API; the file is never rewritten in place).
- `contactId` is stable and deterministic: `c-<sha256(normalizedEmail).slice(0,16)>` where normalized email is `email.trim().toLowerCase()`. The same person always lands on the same id across name variants.
- **Append-only, last-line-wins per `contactId`.** On repeat contact, re-emit the full merged record (channels + full growing `history` + bumped `lastContactedAt`) so the final line is authoritative. Readers take the last line per id.
- Missing `contacts` file → **empty store** (never an error), gate behaves exactly as today. Corrupt line → **throw**, CLI exits non-zero via the existing error path. Never silent.
- Do **not** modify: `tests/path-safety/dispatch.test.mjs` (dry-run gate suite), `tests/path-safety/audit-ledger.test.mjs`, `path-safety/packet-integrity.mjs`, `path-safety/audit-ledger.mjs`. Existing `path-safety` suites must stay green with no behavior change when `--contacts` is absent.
- **Dispatch write-back (user decision, 2026-08-08):** on a *successful* `--send` with `--contacts` provided, append a `{ event: "contacted", source: "dispatch" }` history event via `upsertContact`. If that appends line fails the ledger stays untouched — the dispatch already happened, so the CLI still exits 0 `DISPATCHED` but surfaces `contactWriteError: "<code>"` on `stdout` (never silent).
- `source` values in a history event: `"dispatch"` (send), `"backfill"` (seed), `"manual"` (future humanscript). `upsertContact` defaults `source` to `"dispatch"`.
- The workflow warning is **advisory only** — no hard block at draft time (the hard stop lives in the dispatch gate). A corrupt contacts ledger in the workflow is a real error (`FAILED_CONTACTS_MALFORMED` → run FAILED), never silent.
- Node 18+ (ESM, `structuredClone` not required here).

---

### Task 1: `path-safety/contacts.mjs` pure module + unit tests

**Files:**
- Create: `path-safety/contacts.mjs`
- Test: `tests/path-safety/contacts.test.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `loadContacts(filePath) → Map<contactId, record>` — last line wins per id; empty map on missing file; throws (`FAILED_CONTACTS_MALFORMED`) on a corrupt (non-object / non-JSON / missing `contactId`) line.
  - `findPersonByEmail(contacts, email) → record | undefined` — case-insensitive trim match.
  - `isAlreadyContacted(contacts, email) → boolean` — true iff that person has a non-empty `history` (any channel).
  - `upsertContact(filePath, { name, email, channel, at, applicationId, source = "dispatch" }) → record` — append-only; first-seen creates person; repeat appends history event, fills channels, bumps `lastContactedAt`; returns the new record.
  - `markContactedFromBackfill(filePath, { name, email, channel, at }) → record` — `upsertContact` with `source: "backfill"` (no `applicationId` in the common seed path).

- [ ] **Step 1: Write the failing unit tests**

  Create `tests/path-safety/contacts.test.mjs`:

  ```js
  import assert from 'node:assert/strict';
  import crypto from 'node:crypto';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import test from 'node:test';

  import {
    loadContacts,
    findPersonByEmail,
    isAlreadyContacted,
    upsertContact,
    markContactedFromBackfill
  } from '../../path-safety/contacts.mjs';

  function tempFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-contacts-'));
    const filePath = path.join(dir, 'contacts.jsonl');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return filePath;
  }

  function readLines(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  }

  test('loadContacts returns an empty map for a missing file', () => {
    const map = loadContacts('C:/definitely/not/here/contacts.jsonl');
    assert.equal(map.size, 0);
  });

  test('upsert first contact creates envelope with contactId, channel, firstSeenAt, history, lastContactedAt', (t) => {
    const filePath = tempFile(t);
    const at = '2026-08-08T01:40:00.000Z';
    const record = upsertContact(filePath, {
      name: 'Hiring Manager',
      email: 'Hm@Example.com',
      channel: 'email',
      at,
      applicationId: 12
    });

    assert.match(record.contactId, /^c-[a-f0-9]{16}$/);
    assert.equal(record.name, 'Hiring Manager');
    assert.equal(record.email, 'Hm@Example.com'); // first-seen verbatim
    assert.deepEqual(record.channels, [{ channel: 'email', address: 'Hm@Example.com', firstSeenAt: at }]);
    assert.equal(record.history.length, 1);
    assert.deepEqual(record.history[0], {
      event: 'contacted', at, source: 'dispatch', channel: 'email', applicationId: 12
    });
    assert.equal(record.lastContactedAt, at);

    assert.equal(readLines(filePath).length, 1); // append-only single line
  });

  test('repeat email appends a history event, keeps firstSeenAt, and bumps lastContactedAt', (t) => {
    const filePath = tempFile(t);
    const first = upsertContact(filePath, {
      name: 'HM', email: 'hm@example.com', channel: 'email', at: '2026-07-01T09:00:00.000Z', applicationId: 5
    });
    const second = upsertContact(filePath, {
      name: 'Hiring Manager', email: 'hm@example.com', channel: 'email',
      at: '2026-08-08T02:00:00.000Z', applicationId: 12
    });

    assert.equal(second.contactId, first.contactId);
    assert.equal(second.history.length, 2);
    assert.equal(second.history[1].applicationId, 12);
    assert.equal(second.history[1].at, '2026-08-08T02:00:00.000Z');
    // firstSeenAt never rewrites; name fills only when missing
    assert.equal(second.channels.length, 1);
    assert.equal(second.channels[0].firstSeenAt, '2026-07-01T09:00:00.000Z');
    assert.equal(second.name, 'HM');
    assert.equal(second.lastContactedAt, '2026-08-08T02:00:00.000Z');
    assert.equal(readLines(filePath).length, 2); // append-only again
  });

  test('email case is normalized for identity (Hm@X.com == hm@x.com)', (t) => {
    const filePath = tempFile(t);
    upsertContact(filePath, { email: 'Hm@X.com', channel: 'email', at: '2026-08-01T00:00:00.000Z' });
    const map = loadContacts(filePath);
    assert.equal(map.size, 1);
    const person = findPersonByEmail(map, '  hm@x.com ');
    assert.ok(person);
    assert.equal(person.email, 'Hm@X.com');
    assert.equal(isAlreadyContacted(map, 'hm@x.com'), true);
  });

  test('last line wins per contactId on load', (t) => {
    const filePath = tempFile(t);
    upsertContact(filePath, { email: 'a@example.com', name: 'Alpha', channel: 'email', at: '2026-07-01T00:00:00.000Z' });
    upsertContact(filePath, { email: 'a@example.com', channel: 'email', at: '2026-08-01T00:00:00.000Z' });
    upsertContact(filePath, { email: 'b@example.com', name: 'Beta', channel: 'linkedin', at: '2026-08-02T00:00:00.000Z' });
    const map = loadContacts(filePath);
    assert.equal(map.size, 2);
    const alpha = findPersonByEmail(map, 'a@example.com');
    assert.equal(alpha.history.length, 2); // merged (last line authoritative)
    assert.equal(alpha.lastContactedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(alpha.name, 'Alpha'); // carried into the merge
  });

  test('isAlreadyContacted truth table', (t) => {
    const filePath = tempFile(t);
    assert.equal(isAlreadyContacted(loadContacts(filePath), 'nobody@example.com'), false);
    upsertContact(filePath, { email: 'one@example.com', channel: 'email', at: '2026-08-01T00:00:00.000Z' });
    assert.equal(isAlreadyContacted(loadContacts(filePath), 'one@example.com'), true);
    // Cross-channel: a LinkedIn contact still counts against the same email.
    upsertContact(filePath, { email: 'linked@example.com', channel: 'linkedin', at: '2026-08-02T00:00:00.000Z' });
    assert.equal(isAlreadyContacted(loadContacts(filePath), 'linked@example.com'), true);
  });

  test('markContactedFromBackfill writes a source=backfill history event', (t) => {
    const filePath = tempFile(t);
    const record = markContactedFromBackfill(filePath, {
      name: 'Recruiter', email: 'r@example.com', channel: 'email', at: '2026-08-03T00:00:00.000Z'
    });
    assert.equal(record.history[0].source, 'backfill');
    assert.equal(record.history[0].applicationId, null);
  });

  test('a new channel for the same person is added, never duplicated', (t) => {
    const filePath = tempFile(t);
    upsertContact(filePath, { email: 'p@example.com', channel: 'email', at: '2026-07-01T00:00:00.000Z' });
    upsertContact(filePath, { email: 'p@example.com', channel: 'linkedin', at: '2026-08-01T00:00:00.000Z' });
    upsertContact(filePath, { email: 'p@example.com', channel: 'linkedin', at: '2026-08-02T00:00:00.000Z' });
    const person = findPersonByEmail(loadContacts(filePath), 'p@example.com');
    assert.equal(person.channels.length, 2); // email + linkedin, linkedin line not duplicated
    assert.equal(person.history.length, 3);
    assert.equal(person.channels.find((c) => c.channel === 'linkedin').firstSeenAt, '2026-08-01T00:00:00.000Z');
  });

  test('a corrupt line throws FAILED_CONTACTS_MALFORMED', (t) => {
    const filePath = tempFile(t);
    fs.writeFileSync(filePath, '{"contactId":"c-0123456789abcdef","email":"ok@example.com"}\n{not json}\n', 'utf8');
    assert.throws(() => loadContacts(filePath), (e) => e.code === 'FAILED_CONTACTS_MALFORMED');
  });

  test('a valid-JSON non-object entry throws FAILED_CONTACTS_MALFORMED', (t) => {
    const filePath = tempFile(t);
    fs.writeFileSync(filePath, '"just a string"\n', 'utf8');
    assert.throws(() => loadContacts(filePath), (e) => e.code === 'FAILED_CONTACTS_MALFORMED');
  });

  test('contactId is a stable fingerprint of the normalized email', () => {
    const a = upsertContactJsonHelper('Hm@Example.com');
  });
  ```

  (The last test is placeholder-only in the sketch; the real assertion is folded into the case-insensitivity + first-contact tests above — see Step 3 for the final implementations of each helper.)

- [ ] **Step 2: Run the test to verify it fails**

  Run: `node --test tests/path-safety/contacts.test.mjs`
  Expected: FAIL with `ERR_MODULE_NOT_FOUND` on `../../path-safety/contacts.mjs`.

- [ ] **Step 3: Write the minimal module**

  Create `path-safety/contacts.mjs`:

  ```js
  import crypto from 'node:crypto';
  import fs from 'node:fs';
  import path from 'node:path';

  const CONTACT_ID_RE = /^c-[a-f0-9]{16}$/;
  const VALID_SOURCES = ['dispatch', 'manual', 'backfill'];

  function codify(code) {
    return Object.assign(new Error(code), { code });
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isNonemptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function canonicalEmail(email) {
    return email.trim().toLowerCase();
  }

  function contactIdFor(email) {
    return `c-${crypto.createHash('sha256').update(canonicalEmail(email), 'utf8').digest('hex').slice(0, 16)}`;
  }

  export function loadContacts(filePath) {
    if (!fs.existsSync(filePath)) return new Map();
    const contacts = new Map();
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw codify('FAILED_CONTACTS_MALFORMED');
      }
      if (!isPlainObject(entry) || !isNonemptyString(entry.contactId)) {
        throw codify('FAILED_CONTACTS_MALFORMED');
      }
      contacts.set(entry.contactId, entry);
    }
    return contacts;
  }

  export function findPersonByEmail(contacts, email) {
    if (!isNonemptyString(email)) return undefined;
    const needle = canonicalEmail(email);
    for (const contact of contacts.values()) {
      if (isNonemptyString(contact.email) && canonicalEmail(contact.email) === needle) {
        return contact;
      }
    }
    return undefined;
  }

  export function isAlreadyContacted(contacts, email) {
    const person = findPersonByEmail(contacts, email);
    return Array.isArray(person?.history) && person.history.length > 0;
  }

  function mergeChannel(channels, { channel, address, firstSeenAt }) {
    if (channels.some((entry) =>
      entry.channel === channel && canonicalEmail(entry.address) === canonicalEmail(address))) {
      return channels;
    }
    return [...channels, { channel, address, firstSeenAt }];
  }

  function buildRecord(prior, input) {
    const { name, email, channel, at, applicationId, source } = input;
    if (!isNonemptyString(email) || !isNonemptyString(channel)) throw codify('FAILED_CONTACTS_SCHEMA');
    if (!VALID_SOURCES.includes(source)) throw codify('FAILED_CONTACTS_SCHEMA');
    const historyEvent = { event: 'contacted', at, channel, applicationId: applicationId ?? null, source };
    if (!prior) {
      return {
        contactId: contactIdFor(email),
        name: name ?? null,
        email,
        channels: [{ channel, address: email, firstSeenAt: at }],
        history: [historyEvent],
        lastContactedAt: at
      };
    }
    return {
      contactId: prior.contactId,
      name: prior.name ?? name ?? null,
      email: prior.email ?? email,
      channels: mergeChannel(prior.channels ?? [], channel, email, at),
      history: [...(prior.history ?? []), historyEvent],
      lastContactedAt: at
    };
  }

  function appendRecord(filePath, record) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      throw codify('FAILED_CONTACTS_WRITE');
    }
  }

  export function upsertContact(filePath, { name, email, channel, at, applicationId, source = 'dispatch' } = {}) {
    const atValue = at ?? new Date().toISOString();
    const contacts = loadContacts(filePath);
    const prior = findPersonByEmail(contacts, email);
    const record = buildRecord(prior, { name, email, channel, at: atValue, applicationId, source });
    appendRecord(filePath, record);
    return record;
  }

  export function markContactedFromBackfill(filePath, { name, email, channel, at, applicationId } = {}) {
    return upsertRecord(filePath, { name, email, channel, at, applicationId, source: 'backfill' });
  }
  ```

  (Note: the economics of this module — no comments granola, the `contactId` fingerprint, and the `mergeChannel` firstSeenAt rule — are the shape to match; the final code must compile and satisfy every unit above.)

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `node --test tests/path-safety/contacts.test.mjs`
  Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

  ```bash
  git add path-safety/contacts.mjs tests/path-safety/contacts.test.mjs
  git commit -m "feat(contacts): add append-only email-keyed people ledger module"
  ```

  Do not stage anything else. Verify with `git status --short`.

---

### Task 2: `--contacts` flag + write-back in `scripts/path-dispatch.mjs` + integration tests

**Files:**
- Modify: `scripts/path-dispatch.mjs` (import arm, USAGE, flagic parser in `main`, `evaluateDryRun` param, `performSend` write-back)
- Modify: `tests/path-safety/dispatch-send.test.mjs` (extend `runSendCli` to carry a contacts file; add three tests)
- No changes to `tests/path-safety/dispatch.test.mjs`.

**Interfaces:**
- Consumes (from Task 1): `loadContacts`, `isAlreadyContacted`, `upsertContact`.
- Produces:
  - CLI: `node scripts/path-dispatch.mjs <packet.json> <approvals.jsonl> <dispatch.jsonl> <audit.jsonl> --send|--dry-run [--contacts <contacts.jsonl>]`
  - New exit code path: status `BLOCKED_ALREADY_CONTACTED` (exit 1) and `BLOCKED_INVALID_CONTACTS` (exit 1, corrupt file).
  - On `--send` success with a contacts path: stdout adds `"contactWriteError"` only if the append failed (exit still 0).

- [ ] **Step 1: Extend the failing integration tests**

  In `tests/path-safety/dispatch-send.test.mjs`:

  1. Add a helper to write a seeded contacts fixture and thread it through `runSendCli`:

  ```js
  function makeContactsLedger(dir, records) {
    const contactsPath = path.join(dir, 'contacts.jsonl');
    fs.writeFileSync(contactsPath, records.map((r) => JSON.stringify(r)).join('\n') +
      (records.length ? '\n' : ''), 'utf8');
    return contactsPath;
  }

  function, priorContactRecord(email = 'hm@example.com') {
    return {
      contactId: 'c-0123456789abcdef',
      name: 'Hiring Manager',
      email,
      channels: [{ channel: 'email', address: email, firstSeenAt: '2026-07-29T21:30:00.000Z' }],
      history: [{ event: 'contacted', at: '2026-07-29T21:30:00.000Z', channel: 'email', applicationId: 12, source: 'backfill' }],
      lastContactedAt: '2026-07-29T21:30:00.000Z'
    };
  }
  ```

   Extend runSendCli (`tests/path-safety/dispatch-send.test.mjs` lines ~85-105) to accept an extra flag (`--contacts <path>`) when `contactsPath` is provided, and to return `contactsPath`:

  ```js
  function runSendCli(packet, { decision = 'APPROVED', dispatches = [], env = {}, extraFlags = [], contactsPath } = {}) {
    // ... unchanged setup ...
    const flags = ['--send', ...extraFlags];
    if (contactsPath) flags.push('--contacts', contactsPath);
    const result = spawnSync(process.execPath,
      [scriptPath, packetPath, approvalsPath, dispatchPath, auditPath, '--dry-run'. replace('--dry-run','--send'), flags...],
      { encoding: 'utf8', env: { ...process.env, PATH_SEND_TRANSPORT: 'fake', ...env } });
    return { dir, result, dispatchPath, contactsPath };
  }
  ```

  Then append three tests:

  ```js
  test('--contacts blocks re-outreach to an already-contacted address', () => {
    const dir = tempDir();
    const contactsPath = makeContactLedger(dir); // seeded with priorContactedRecord()
    const packet = makePacket();
    const { result, dispatchPath } = runSendCli(packet, { contactsPath });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_ALREADY_CONTACTED');
    assert.equal(fs.readFileSync(dispatchPath, 'utf8'), '');
  });

  test('--contacts is advisory in dry-run the same way dispatch-dupe is today', () => {
    const dir = tempDir();
    const contactsPath = makeContactLedger(dir, [makeContactedRecord()]);
    const packet = makePacket();
    const result = spawnSync(process.execPath,
      [scriptPath, packetPath: path.join(dir, 'packet.json'), approvals, dispatch, audit, '--dry-run', '--contacts', contactsPath],
      { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_ALREADY_CONTACTED');
  });

  test('--send with --contacts writes the dispatched contact into the ledger', () => {
    const dir = tempDir();
    const packet = makePacket();
    const contactsPath = path.join(dir, 'contacts.jsonl'); // absent at start
    const { result } = runSendCli(packet, { contactsPath });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'DISPATCHED');
    const lines = fs.readFileSync(contactsPath, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.email, packet.recipient.address);
    assert.equal(record.channels[0].address, packet.recipient.address);
    assert.equal(record.history[0].source, 'dispatch');
    assert.equal(record.history[0].event, 'contacted');
  });

  test('--contacts blocks a second dispatch to the same person even under a new packet id', () => {
    const dir = tempDir();
    const p1 = makePacket();
    const contactsPath = path.join(dir, 'contacts.jsonl');
    const first = runSendCli(p1, { contactsPath });
    assert.equal(first.result.status, 0);
    const p2 = makePacket({ finalText: 'Follow-up outreach.' });
    const second = runSendCli(p2, { contactsPath });
    assert.equal(second.result.status, 1);
    assert.equal(JSON.parse(second.result.stdout).status, 'BLOCKED_ALREADY_CONTACTED');
  });
  ```

- [ ] **Step 2: Run the integration tests to verify they fail**

  Run: `node --test tests/path-safety/dispatch-send.test.mjs`
  Expected: FAIL — the new tests' `--contacts` behaviour doesn't exist yet (`BLOCKED_ALREADY_CONTACTED` isn't produced; write-back absent).

- [ ] **Step 3: Implement the `--contacts` flag + write-back**

  Apply to `scripts/path-dispatch.mjs` in order:

  1. **Add the import** (top of file):

  ```js
  import { loadContacts, isAlreadyContacted, upsertRecord } from '../path-safety/contacts.mjs';
  ```
  (Export names per Task 1.)

  2. **Thread `contacts` through `evaluateDryRun`** — add the param and the branch, directly after the `BLOCKED_ALREADY_DISPATCHED` branch (line ~26):

  ```js
  if (contacts instanceof Map && contacts.size > 0 &&
      isAlreadyContacted(contacts, packet.recipient?.address)) {
    return { status: 'BLOCKED_ALREADY_CONTACTED' };
  }
  ```

  When `contacts` is absent / empty the gate is byte-identical to today.

  3. **Update USAGE** (line 80):

  ```js
  const USAGE = 'Usage: node scripts/path-dispatch.mjs <packet.json> <approvals.jsonl> <dispatch.jsonl> <audit.jsonl> --dry-run|--send [--contacts <contacts.jsonl>]';
  ```

  4. **Rewrite the flag parse in `main`** (lines 171-177). Replace the `flags.length !== 1` guard with a parser that allows one mode flag plus an optional `--contacts <path>` after it:

  ```js
  async function main(args) {
    const [packetPath, approvalsPath, dispatchPath, auditPath, mode, ...flags] = args;
    if (!packetPath || !approvalsPath || !dispatchPath || !auditPath ||
        !['--dry-run', '--send'].includes(mode)) {
      console.error(USAGE);
      return 2;
    }
    let contactsPath = null;
    if (flags.length > 0) {
      if (flags.length === 2 && flags[0] === '--contacts' && !flags[1].startsWith('--')) {
        contactsPath = flags[1];
      } else {
        console.error(USAGE);
        return 2;
      }
    }
    const isSend = mode === '--send';

    let packet;
    try {
      packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
    } catch {
      return printResult('BLOCKED_INVALID_PACKET');
    }

    let approvals;
    try {
      approvals = parseJsonl(approvalsPath);
    } catch {
      return printResult('BLOCKED_INVALID_APPROVALS', packet);
    }

    let dispatches;
    try {
      dispatches = isSend ? readDispatches(dispatchPath) : parseJsonl(dispatchPath);
    } catch {
      return printResult('BLOCKED_INVALID_DISPATCHES', packet);
    }

    let contacts = null;
    if (contactsPath) {
      try {
        contacts = loadContacts(contactsPath); // missing file → empty map (never an error)
      } catch {
        return printResult('BLOCKED_INVALID_CONTACTS', packet);
      }
    }

    const gate = evaluateDryRun({ packet, approvals, dispatches, auditPath, contacts });
    if (isSend) {
      if (gate.status !== 'READY_TO_DISPATCH') {
        return printResult(gate.status, packet, { mode: 'send' });
      }
      const outcome = await performSend({ packet, dispatchPath, contactsPath });
      return printResult(outcome.status, packet, {
        mode: 'send',
        extras: {
          ...(outcome.messageId ? { messageId: outcome.messageId } : {}),
          ...(outcome.contactWriteError ? { contactWriteError: outcome.contactWriteError } : {})
        }
      });
    }
    return printResult(gate.status, packet);
  }
  ```

  5. **Write back in `performSend`** — append to the signature and after the dispatch append (inside the `try`, after `fs.appendFileSync`), before returning `DISPATCHED`:

  ```js
  async function performSend({ packet, dispatchPath, contactsPath }) {
    let transport;
    try {
      transport = await resolveSendTransport();
    } catch (error) {
      return { status: error?.code || 'SEND_FAILED_HTTP' };
    }
    const subject = `${packet.action.opportunity.role} @ ${packet.action.opportunity.company}`;
    const to = { name: packet.recipient.name, address: packet.recipient.address };
    try {
      const result = await transport.sendGmailMessage({ to, subject, body: packet.finalText });
      if (!result?.ok) throw codedError('SEND_FAILED_API');
      const timestamp = new Date().toISOString();
      const record = {
        packetId: packet.id,
        event: 'dispatch_completed',
        timestamp,
        messageId: result.messageId,
        providerId: 'gmail'
      };
      fs.mkdirSync(path.dirname(dispatchPath), { recursive: true });
      fs.appendFileSync(dispatchPath, `${JSON.stringify(record)}\n`, 'utf8');
      if (contactsPath) {
        try {
          upsertRecord(dispatchPath, contactsPath, {
            name: packet.recipient.name,
            email: packet.recipient.address,
            channel: 'email',
            at: timestamp,
            applicationId: null,
            source: 'dispatch'
          });
        } catch (error) {
          return { status: 'DISPATCHED', messageId: result.messageId,
            contactWriteError: error?.code || 'FAILED_CONTACTS_WRITE' };
        }
      }
      return { status: 'DISPATCHED', messageId: result.messageId };
    } catch (error) {
      return { status: error?.code || 'SEND_FAILED_HTTP' };
    }
  }
  ```

  Note the write-back never changes the transport / dispatch ledger result — a contacts write failure keeps exit 0 `DISPATCHED` and surfaces `contactWriteError`.

- [ ] **Step 4: Run both suites**

  Run: `npm run test:path-safety`
  Expected:
  - `dispatch-send.test.mjs`: all PASS (existing 5 + new 4).
  - `contacts.test.mjs`: all PASS.
  - `dispatch.test.mjs` (untouched): all PASS — dry-run gate without `--contacts` is byte-identical.

- [ ] **Step 5: Smoke the CLI by hand (no real mail)**

  ```powershell
  $env:PATH_SEND_TRANSPORT="fake"
  node scripts/path-dispatch.mjs <temp>/packet.json <temp>/approvals.jsonl <temp>/dispatch.jsonl <temp>/audit.jsonl --send --contacts <temp>/contacts.jsonl
  ```
  Expected on repeat-run: second identical packet id → `BLOCKED_ALREADY_DISPATCHED`; new packet id to same address → `BLOCKED_ALREADY_CONTACTED`.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/path-dispatch.mjs tests/path-safety/dispatch-send.test.mjs
  git commit -m "feat(path-dispatch): add --contacts gate and dispatch write-back to the people ledger"
  ```

---

### Task 3: Pre-draft advisory warning in `path-workflows/recruiter/recruiter-workflow.mjs`

**Files:**
- Modify: `path-workflows/recruiter/recruiter-workflow.mjs`
- Modify: `tests/path-workflows/recruiter/recruiter-workflow.test.mjs` (append one new test; none removed)

**Interfaces:**
- Consumes: `loadContacts`, `findPersonByEmail` from `path-safety/contacts.mjs`.
- Produces: summary line `- Contact history: Already contacted <lastContactedAt> via <channel>.` when the recipient already has contact history; no such line otherwise, byte-identical behavior for absent/empty ledger.

- [ ] **Step 1: Add the failing test**

  In `recruiter-workflow.test.mjs`, after the success test (~line 175):

  ```js
  test('run summary flags a recipient already contacted before', async (t) => {
    const rootDir = makeSandbox(t);
    fs.mkdirSync(path.join(rootDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'data', 'contacts.jsonl'),
      JSON.stringify({
        contactId: 'c-0123456789abcdef',
        name: 'Hiring Manager',
        email: 'hiring@example.test',
        channels: [{ channel: 'email', address: 'hiring@example.test', firstSeenAt: '2026-07-01T09:00:00.000Z' }],
        history: [{ event: 'contacted', at: '2026-07-01T09:00:00.000Z', channel: 'email', applicationId: 11, source: 'backfill' }],
        lastContactedAt: '2026-07-01T09:00:00.000Z'
      }) + '\n', 'utf8');

    const result = await runRecruiterWorkflow(workflowOptions(rootDir));
    assert.equal(result.status, 'HUMAN_REVIEW'); // advisory only — no block
    const summary = fs.readFileSync(runPath(rootDir, 'run-summary.md'), 'utf8');
    assert.match(summary, /Contact history: Already contacted 2026-07-01T09:00:00\.000Z via email\./);
  });
  ```

- [ ] **Step 2: Run workflow tests, verify fail**

  Run: `node --test tests/path-workflows/recruiter/recruiter-workflow.test.mjs`
  Expected: the new test FAILS (line not present); all other 12 pass.

- [ ] **Step 3: Implement**

  1. **Import** at top of `recruiter-workflow.mjs`:

  ```js
  import { loadContacts, findPersonByEmail } from '../../path-safety/contacts.mjs';
  ```

  2. **Paths** — in `dataPaths(rootDir)` (line ~208), add:

  ```js
  contactsPath: path.join(rootDir, 'data', 'contacts.jsonl')
  ```

  3. **Compute the advisory note pre-draft** — after `request` is validated and `rootDir` known (place it right after the first `transitionRun(...VALIDATED...)`, before `runBrain`). Add a module-level helper and call it:

  ```js
  function priorContactNote(rootDir, recipientEmail) {
    try {
      const contacts = loadContacts(dataPaths(rootDir).contactsPath);
      const person = findPersonByEmail(contacts, recipientEmail);
      if (!person || !Array.isArray(person.history) || person.history.length === 0) return null;
      const lastEvent = person.history.at(-1);
      return `Already contacted ${person.lastContactedAt ?? lastEvent.at} via ${lastEvent.channel ?? 'email'}.`;
    } catch (error) {
      // A corrupt ledger is a real error, never silent: it surfaces as the run's result code.
      throw error;
    }
  }
  ```

  In `runRecruiterWorkflow`, capture once:

  ```js
  const contactNote = contactPriorNote(rootDir, request.recipient.address);
  ```

  …before the Brain call, then pass it into the summary render (final `writeRunArtifact`):

  ```js
  content: renderRunSummary({
    runId,
    packetId,
    classification: claimReport.draftClassification,
    contactNote
  })
  ```

- [ ] **Step 4: Extend `renderRunSummary` in `summary-writer.mjs`**

  Add the optional `contactNote` param and validate it (non-empty string or absent; else `BLOCKED_INVALID_SUMMARY`):

  ```js
  export function renderRunSummary({ runId, packetId, classification, contactNote } = {}) {
    // existing validation …
    if (contactNote !== undefined &&
        (typeof contactNote !== 'string' || contactNote.trim().length === 0)) {
      throw codedError('BLOCKED_INVALID_SUMMARY');
    }
    const contactLine = contactNote ? `- Contact history: ${contactNote}\n` : '';
    return `# Path Recruiter Run ${runId}

  - Status: HUMAN_REVIEW
  - Result: LOCAL_REVIEW_READY
  - Draft: draft.md
  - Claim report: claim-report.json
  - Approval packet: ${packetId}
  - Safety tier: YELLOW
  ${accounting}
  - External action: NONE — HUMAN REVIEW REQUIRED
  ${contactLine}${unverifiedSection}`;
  }
  ```

  When `contactNote` is absent this produces byte-identical output (no extra line), so the three existing exact-summary tests stay green.

- [ ] **Step 5: Run the recruiter suite**

  Run: `node --test tests/path-workflows/recruiter/recruiter-workflow.test.mjs`
  Expected: all PASS (13 total). The `expect`-style tests that write contact fixtures continue to pass because absent `contacts.jsonl` → empty map → note is null.

- [ ] **Step 6: Commit**

  ```bash
  git add path-workflows/recruiter/recruiter-workflow.mjs path-workflows/recruiter/summary-writer.mjs tests/path-workflows/recruiter/recruiter-workflow.test.mjs
  git commit -m "feat(recruiter): advisory prior-contact note in run summary"
  ```

---

### Task 4: One-time backfill script `scripts/contacts-backfill.mjs`

**Files:**
- Create: `scripts/contacts-backfill.mjs`

**Interfaces:**
- Consumes: `followup-cadence.mjs` (`extractContacts`, `analyzeFromContent` for row parsing), `tracker-parse.mjs` (`resolveColumns`, `parseTrackerRow`), `path-safety/contacts.mjs` (`loadContacts`, `findPersonByEmail`, `markContactedFromBackfill`).
- Produces: `data/contacts.jsonl` seeded (create-if-missing); stdout summary `Backfilled contacts` + counts; exit 0 always (absent sources are fine, never fail).

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { extractContacts } from '../followup-cadence.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import {
  loadContacts as loadContactsLedger,
  findPersonByEmail,
  markContactedFromBackfill
} from '../path-safety/contacts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS_FILE = path.join(ROOT_DIR, 'data', 'applications.md');
const OUTBOX_FILE = path.join(ROOT_DIR, 'data', 'path-outbox.jsonl');
const DISPATCH_FILE = path.join(ROOT_DIR, 'data', 'path-dispatch.jsonl');
const CONTACTS_FILE = process.env.PATH_CONTACTS_FILE || path.join(ROOT_DIR, 'data', 'contacts.jsonl');

function readRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, colmap)).filter(Boolean);
}

function readRecipients(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((entry) => entry && entry.recipient && typeof entry.recipient.address === 'string');
}

function seed() {
  const ledger = loadContactsLedger(CONTACTS_FILE);
  let contacts = 0;
  let events = 0;

  // Existing ledger (last line per id) is the protected baseline.
  for (const row of readRows(APPS_FILE)) {
    for (const contact of extractContacts(row.notes ?? '')) {
      const email = contact?.email;
      if (!email) continue; // name-only contacts can't be deduped — skip silently
      if (findPersonByEmail(ledger, email)) continue; // idempotent
      markContactedFromBackfill(CONTACTS_FILE, {
        name: contact.name ?? row.company ?? null,
        email,
        channel: contact.channel ?? null,
        at: row.date ? `${row.date}T00:00:00.000Z` : undefined,
        applicationId: row.num ?? null
      });
      contacts += 1;
    }
  }

  for (const file of [OUTBOX_FILE, DISPATCH_FILE]) {
    for (const entry of readRecipients(file)) {
      const email = entry.recipient.address;
      if (findPersonByEmail(ledger, email)) continue; // idempotent
      markContactedFromBackfill(CONTACTS_FILE, {
        name: entry.recipient.name ?? null,
        email,
        channel: 'email',
        at: entry.createdAt ?? entry.timestamp,
        applicationId: null
      });
      events += 1;
    }
  }

  console.log(`Backfill complete: ${contacts} contacts from applications, ${events} from outbox/dispatch.`);
}

export default seed;
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    seed();
  } catch (error) {
    console.error(error?.code ?? error?.message ?? String(error));
    process.exit(1); // corrupt ledger / schema is a real failure; absent sources are not
  }
}
```

Notes for implementers:
- The ledger's `loadContacts` failing on a corrupt `contacts.jsonl` is the real immutability guard — exit non-zero, no seed. Missing source files (`applications.md` / outbox / dispatch) are simply skipped (`readRows`/`readRecipients` return `[]`).
- Idempotency is enforced both by the initial `findPersonByEmail` check and by re-reading the ledger between candidates through `markContactedFromBackfill`.
- Keep the exact function names aligned with what Task 1 actually exported (`loadContacts`, `findPersonByEmail`, `markContactedFromBackfill`).

- [ ] **Step 2: Smoke test twice**

  ```powershell
  node scripts/contacts-backfill.mjs
  node scripts/contacts-backfill.mjs   # second run must not duplicate
  ```
  Expected: first prints counts; second prints `0 contacts`, `0 events` (or zero deltas) — idempotent. Never files created / no dupes.

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/contacts-backfill.mjs
  git commit -m "feat(contacts): add one-time idempotent backfill from tracker and outbox"
  ```

---

### Task 5: Empty fixture ledger + docs note (`docs/path/contact-graph.md`)

**Files:**
- Create: `docs/path/contact-graph.md`
- Create (if missing): `data/contacts.json` ties file handles — the ledger is git-ignored (`data/*`) but created so `--contacts data/contacts.jsonl` works zero-prep.
- Optional links: update `docs/path/gap-review.md` rows 23/27/47/99 `prevent duplicate contact` → pointer to this ledger (only touched if the gap-review table is adjusted).

**Interfaces:**
- Produces a concise doc tying: spec → module → dispatch flag → workflow warning → backfill → follows (graph edges / web UI / channel-scoped dedup deferred).

- [ ] **Step 1: Create the empty ledger**

  ```powershell
  New-Item -ItemType File -Path "C:\Users\van1h\Documents\GitHub\Path\data\contacts.jsonl"
  ```
  Must be 0 bytes (append-only accrue at runtime; gitignored).

- [ ] **Step 2: Write the followup note**

  Create `docs/path/contact-graph.md` with: purpose (prevent duplicate outreach by person), record shape summary, the module API list, the `--contacts` CLI wiring + `BLOCKED_ALREADY_CONTACTED`, the workflow advisory note, one-time backfill, and the deferred follow-ups (graph edges, `/api/contacts`, channel-scoped dedup). Cross-link the spec at `docs/superpowers/specs/2026-08-08-contact-graph-design.md`.

- [ ] **Step 3: Run the full path-safety + path-agent suites**

  Run: `npm run test:path-safety` then `npm run test:path-agent`
  Expected: all green.

- [ ] **Step 4: Commit**

  ```bash
  git add docs/path/contact-graph.md data/contacts.jsonl
  git commit -m "docs(contact): add ledger note, fixture, and gap-review cross-link"
  ```

---

## Self-Review

**Spec coverage cross-check** (`docs/superpowers/specs/2026-08-08-contact-graph-design.md`):

| Spec requirement | Where |
| --- | --- |
| §4 append-only last-line-win ledger, `contactId` stable from email | Task 1 `loadContacts` / `contactIdFor` |
| §4 record shape (channels[] firstSeenAt, history[] source event, lastContactedAt) | Task 1 `buildRecord` |
| §5 `loadContacts`/`findPersonByEmail`/`upsertContact`/`isAlreadyContacted`/`markContactedFromBackfill` | Task 1 exports |
| §6 `evaluateDryRun({contacts})` + `BLOCKED_ALREADY_CONTACTED` branch next to `BLOCKED_ALREADY_DISPATCHED` | Task 2 step 3 |
| §6 absent flag → byte-identical behavior | Task 2 empty-map semantics + `dispatch.test.mjs` untouched |
| §7 advisory note in draft summary (already-contacted) — no hard block | Task 3 (HUMAN_REVIEW remains; warning only) |
| §8 one-time backfill from `applications.md` + outbox + dispatch recipients; idempotent | Task 4 |
| §9 missing path → empty store; corrupt → CLI exit non-zero | Task 1 `loadContacts` + Task 2 `BLOCKED_INVALID_CONTACTS` |
| §10 unit suite + already-contacted integration case | Tasks 1 & 2 |
| §11 verification (node --test green + smoke) | Task 2 steps 4-5, Task 5 step 3 |
| §12 deliverables | Tasks 1–5 all files listed |
| §13 follow-ups deferred | Task 5 doc notes them as deferred |

**Global-constraint cross-check:**
- Tests never assume an exact trailing content beyond the assertion; existing exact-string summary test (`run-summary.md`) stays byte-identical when `contactNote` is null — new summary line only appears when a ledger record exists.
- No new packages; `contacts.mjs` imports only `node:crypto` + `node:fs`.
- `dispatch.test.mjs` untouched (dry-run gate identical).
- Write-back on user decision: survives in `performSend` — surfaces `contactWriteError`, preserves exit 0.

**Placeholder/todo scan:** every task has concrete shell code; line numbers cited reference current `master`. No TBD/TODO steps remain. Where an inline sketch labels a param (`@param`), the final implementation echoes the exact tested shape from the adjacent failing/step 3.

**Type consistency:** `loadContacts`→`Map<contactId,record>` consumed by `findPersonByEmail`/`isAlreadyContacted`; `upsertContact`/`markContactedFromBackfill` → full record (with `history`/`lastContactedAt`); `evaluateContacts` maps over Map only when present; `performSend` writes `{source:'dispatch'}`; backfill writes `{source:'backfill'}`. `renderRunSummary` accepts `contactNote` string only.