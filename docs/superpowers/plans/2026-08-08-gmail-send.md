# Real Gmail Send for the Approval-Gated Dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send an approval-gated recruiter packet for real — plain-text Gmail message behind the existing `evaluateDryRun()` gate in `scripts/path-dispatch.mjs`, with a new pure transport module and full test coverage.

**Architecture:** `transports/gmail-send.mjs` is a pure, state-free transport (`sendGmailMessage`) that does OAuth refresh + `messages/send` over raw `fetch`. `scripts/path-dispatch.mjs` gains a `--send` mode that shares the exact existing gate (`evaluateDryRun`), derives a subject from `packet.action.opportunity`, sends, and appends a `dispatch_completed` record to the dispatch ledger only after a 2xx with a real `messageId`. A `PATH_SEND_TRANSPORT=fake` env seam lets integration tests exercise the full CLI without hitting the network.

**Tech Stack:** Node.js (ESM), `node:test` + `spawnSync` (existing test conventions), built-in `fetch`, existing `dotenv` dependency. No new packages.

## Global Constraints

- Zero new package dependencies — use raw `fetch` (same as `plugins/gmail/index.mjs`), `Buffer.from(msg).toString('base64url')`, and the existing `dotenv` package already in `package.json`.
- Do **not** modify: `path-safety/*`, `web/`, the audit ledger schema, or any existing test file (`tests/path-safety/dispatch.test.mjs` must keep passing untouched).
- `dispatch_completed` records live **only** in the dispatch ledger argument; they are not `EVENT_RULES` members and never enter the audit chain.
- The ledger record is written only after a confirmed 2xx + `messageId`; any failure prints `SEND_FAILED_*` and exits 1 without touching the ledger.
- Exactly one flag required: `--dry-run` (unchanged) or `--send` (new); anything else → usage exit 2.
- Env var names: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (already documented in `.env.example`).
- Credentials come from `.env` loaded via an idempotent lazy `loadDotenvOnce()` (dynamic `await import('dotenv')`) — never `import 'dotenv/config'` at module top.
- Node 18+ required (global `fetch`, global `crypto.randomUUID`).

---

### Task 1: `transports/gmail-send.mjs` pure transport + unit tests

**Files:**
- Create: `transports/gmail-send.mjs`
- Test: `tests/path-safety/gmail-send.test.mjs`

**Interfaces:**
- Consumes: nothing (this is the first task).
- Produces:
  - `sendGmailMessage({ clientId, clientSecret, refreshToken, to, subject, body, fetchFn = globalThis.fetch }) → Promise<{ ok: true, messageId: string }>` where `to = { name: string, address: string }`. Throws a `codedError` (an `Error` whose `.message` equals `.code`) with codes `SEND_FAILED_OAUTH`, `SEND_FAILED_API`, `SEND_FAILED_HTTP`.

- [ ] **Step 1: Write the failing unit tests**

  Create `tests/path-safety/gmail-send.test.mjs`:

  ```js
  import assert from 'node:assert/strict';
  import test from 'node:test';
  import { sendGmailMessage } from '../../transports/gmail-send.mjs';

  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

  const DEFAULT_ARGS = {
    clientId: 'cid',
    clientSecret: 'csec',
    refreshToken: 'rtok',
    to: { name: 'Hiring Manager', address: 'hm@example.com' },
    subject: 'AI Engineer @ Example Company',
    body: 'Agent workflows on Windows 11.'
  };

  function tokenResponse() {
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok-1' }) };
  }

  test('happy path posts raw message to messages/send and returns messageId', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init });
      if (url === TOKEN_URL) return tokenResponse();
      return { ok: true, status: 200, json: async () => ({ id: 'msg-abc' }) };
    };

    const result = await sendGmailMessage({ ...DEFAULT_ARGS, fetchFn });
    assert.deepEqual(result, { ok: true, messageId: 'msg-abc' });

    const [tokenCall, sendCall] = calls;
    assert.equal(tokenCall.url, TOKEN_URL);
    assert.match(tokenCall.init.headers['Content-Type'], /application\/x-www-form-urlencoded/);
    assert.match(tokenCall.init.body.toString(), /client_id=cid/);
    assert.match(tokenCall.init.body.toString(), /refresh_token=rtok/);
    assert.match(tokenCall.init.body.toString(), /grant_type=refresh_token/);
    assert.equal(tokenCall.init.method, 'POST');

    assert.equal(sendCall.url, SEND_URL);
    assert.equal(sendCall.init.method, 'POST');
    assert.equal(sendCall.init.headers.Authorization, 'Bearer tok-1');
    assert.match(sendCall.init.headers['Content-Type'], /application\/json/);

    const raw = JSON.parse(sendCall.init.body).raw;
    const message = Buffer.from(raw, 'base64url').toString('utf8');
    assert.match(message, /^To: Hiring Manager <hm@example\.com>\r?\n/i);
    assert.match(message, /^Subject: AI Engineer @ Example Company\r?\n/i);
    assert.match(message, /^MIME-Version: 1\.0\r?\n/i);
    assert.match(message, /^Content-Type: text\/plain/i);
    assert.ok(message.endsWith('Agent workflows on Windows 11.'), message);
  });

  test('token refresh rejection maps to SEND_FAILED_OAUTH and does not hit the send endpoint', async () => {
    let sendCalled = false;
    const fetchFn = async (url) => {
      if (url === SEND_URL) sendCalled = true;
      return { ok: false, status: 400, json: async () => ({}), text: async () => 'bad grant' };
    };
    await assert.rejects(
      sendGmailMessage({ ...DEFAULT_ARGS, fetchFn }),
      (err) => err.message === 'SEND_FAILED_OAUTH'
    );
    assert.equal(sendCalled, false);
  });

  for (const status of [400, 403, 429, 500]) {
    test(`API ${status} maps to SEND_FAILED_API`, async () => {
      const fetchFn = async (url) => {
        if (url === TOKEN_URL) return tokenResponse();
        return { ok: false, status, json: async () => ({}), text: async () => 'nope' };
      };
      await assert.rejects(
        sendGmailMessage({ ...DEFAULT_ARGS, fetchFn }),
        (err) => err.message === 'SEND_FAILED_API'
      );
    });
  }

  test('send-endpoint fetch rejection maps to SEND_FAILED_HTTP', async () => {
    const fetchFn = async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      throw new TypeError('ENOTFOUND example.com');
    };
    await assert.rejects(
      sendGmailMessage({ ...DEFAULT_ARGS, fetchFn }),
      (err) => err.message === 'SEND_FAILED_HTTP'
    );
  });

  test('token-endpoint fetch rejection maps to SEND_FAILED_OAUTH', async () => {
    const fetchFn = async () => {
      throw new TypeError('ECONNREFUSED');
    };
    await assert.rejects(
      sendGmailMessage({ ...DEFAULT_ARGS, fetchFn }),
      (err) => err.message === 'SEND_FAILED_OAUTH'
    );
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `node --test tests/path-safety/gmail-send.test.mjs`
  Expected: FAIL with `ERR_MODULE_NOT_FOUND` on `../../transports/gmail-send.mjs`.

- [ ] **Step 3: Write the minimal transport implementation**

  Create `transports/gmail-send.mjs`:

  ```js
  // @ts-check
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

  function codedError(code, cause) {
    return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
  }

  function buildMessage({ to, subject, body }) {
    return [
      `To: ${to.name} <${to.address}>`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body
    ].join('\r\n');
  }

  async function exchangeAccessToken({ clientId, clientSecret, refreshToken }, fetchFn) {
    let response;
    try {
      response = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        })
      });
    } catch (error) {
      throw codedError('SEND_FAILED_OAUTH', error);
    }
    if (!response.ok) throw codedError('SEND_FAILED_OAUTH');
    const data = await response.json().catch(() => ({}));
    if (!data.access_token) throw codedError('SEND_FAILED_OAUTH');
    return data.access_token;
  }

  export async function sendGmailMessage({
    clientId,
    clientSecret,
    refreshToken,
    to,
    subject,
    body,
    fetchFn = globalThis.fetch
  }) {
    const accessToken = await exchangeAccessToken({ clientId, clientSecret, refreshToken }, fetchFn);
    const raw = Buffer.from(buildMessage({ to, subject, body }), 'utf8').toString('base64url');

    let response;
    try {
      response = await fetchFn(SEND_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ raw })
      });
    } catch (error) {
      throw codedError('SEND_FAILED_HTTP', error);
    }
    if (!response.ok) {
      await response.text().catch(() => {});
      throw codedError('SEND_FAILED_API');
    }
    const data = await response.json().catch(() => ({}));
    if (!data.id) throw codedError('SEND_FAILED_API');
    return { ok: true, messageId: data.id };
  }
  ```

- [ ] **Step 4: Run the test to verify it passes**

  Run: `node --test tests/path-safety/gmail-send.test.mjs`
  Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

  ```bash
  git add transports/gmail-send.mjs tests/path-safety/gmail-send.test.mjs
  git commit -m "feat(gmail-send): add pure fetch transport with unit tests"
  ```

  Do not stage anything else. Verify with `git status --short`.

---

### Task 2: `--send` mode in `scripts/path-dispatch.mjs` + integration tests

**Files:**
- Modify: `scripts/path-dispatch.mjs` (imports, `printResult`, `main`, CLI guard — lines ~1-2, 78-86, 88-122)
- Create: `tests/path-safety/dispatch-send.test.mjs`
- No changes to `tests/path-safety/dispatch.test.mjs`.

**Interfaces:**
- Consumes (from Task 1): `sendGmailMessage({ clientId, clientSecret, refreshToken, to, subject, body, fetchFn }) → { ok: true, messageId }`.
- Consumes (existing): `evaluateDryRun({ packet, approvals, dispatches, auditPath }) → { status }`.
- Produces:
  - CLI: `node scripts/path-dispatch.mjs <packet.json> <approvals.jsonl> <dispatch.jsonl> <audit.jsonl> --dry-run|--send`
  - Exit codes: 0 on `READY_TO_DISPATCH` (dry-run) and `DISPATCHED` (send success); 1 on any `BLOCKED_*`/`SEND_FAILED_*`; 2 on usage error.
  - `process.env.PATH_SEND_TRANSPORT === 'fake'` routes to an in-script fake transport; `process.env.PATH_SEND_FAKE_FAIL === '1'` makes the fake throw `SEND_FAILED_API`.
  - Ledger record shape: `{ packetId, event: "dispatch_completed", timestamp, messageId, providerId: "gmail" }`.

- [ ] **Step 1: Write the failing integration test**

  Create `tests/path-safety/dispatch-send.test.mjs` (fixtures mirrored from `dispatch.test.mjs` — subprocess is the unit of truth):

  ```js
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { spawnSync } from 'node:child_process';
  import test from 'node:test';
  import { appendAuditRecord } from '../../path-safety/audit-ledger.mjs';
  import { buildPacketIntegrityFields } from '../../path-safety/packet-integrity.mjs';

  const scriptPath = path.resolve('scripts/path-dispatch.mjs');

  function auditRecordFor(packet, decision = 'APPROVED') {
    return {
      event: 'approval_decision_recorded',
      runId: null,
      packetId: packet.id,
      integritySha256: packet.integritySha256,
      idempotencyKey: packet.idempotencyKey,
      action: packet.action,
      recipient: packet.recipient,
      finalText: packet.finalText,
      evidenceIds: packet.evidenceIds,
      evidenceHashes: packet.evidenceHashes,
      claimReportHash: packet.claimReportHash,
      tier: packet.tier,
      policyVersion: packet.policyVersion,
      voiceProfile: packet.voiceProfile,
      disclosurePolicy: packet.disclosurePolicy,
      disclosureIncluded: packet.disclosureIncluded,
      provider: packet.provider,
      model: packet.model,
      promptVersion: packet.promptVersion,
      decision
    };
  }

  function writeAuditLedger(dir, records) {
    const auditPath = path.join(dir, 'audit.jsonl');
    for (const record of records) appendAuditRecord(auditPath, record);
    return auditPath;
  }

  function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'path-send-'));
  }

  function makePacket(overrides = {}) {
    const createdAt = new Date().toISOString();
    const base = {
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString(),
      status: 'AWAITING_VAN_APPROVAL',
      tier: 'YELLOW',
      action: {
        type: 'send_email', channel: 'gmail', touch: 'first',
        opportunity: { company: 'Example Company', role: 'AI Engineer' }
      },
      recipient: { name: 'Hiring Manager', address: 'hm@example.com' },
      finalText: 'Agent workflows on Windows 11.',
      evidenceIds: ['fact-1'],
      evidenceHashes: ['a'.repeat(64)],
      claimReportHash: 'b'.repeat(64),
      voiceProfile: 'path-recruiter-persistent-respectful-v1',
      disclosurePolicy: 'always-disclose-ai-assistance-v1',
      disclosureIncluded: true,
      promptVersion: 'path-recruiter-v1',
      provider: 'fake',
      model: 'deterministic-recruiter-template-v1',
      policyVersion: 'path-safety-v1',
      ...overrides
    };
    return { ...base, ...buildPacketIntegrityFields(base) };
  }

  function approvalFor(packet, decision = 'APPROVED') {
    return {
      packetId: packet.id,
      integritySha256: packet.integritySha256,
      idempotencyKey: packet.idempotencyKey,
      decision,
      decidedBy: 'Van'
    };
  }

  function runSendCli(packet, {
    decision = 'APPROVED',
    dispatches = [],
    env = {},
    extraFlags = []
  } = {}) {
    const dir = tempDir();
    const packetPath = path.join(dir, 'packet.json');
    fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
    const approvalsPath = path.join(dir, 'approvals.jsonl');
    fs.writeFileSync(approvalsPath, `${JSON.stringify(approvalFor(packet, decision))}\n`, 'utf8');
    const dispatchPath = path.join(dir, 'dispatch.jsonl');
    fs.writeFileSync(dispatchPath, dispatches.map(JSON.stringify).join('\n') + (dispatches.length ? '\n' : ''), 'utf8');
    // Audit ledger is always APPROVED (mirrors dispatch.test.mjs runCli: the
    // approvals file carries the decision; BLOCKED_REJECTED comes from it).
    const auditPath = writeAuditLedger(dir, [auditRecordFor(packet)]);
    const result = spawnSync(process.execPath,
      [scriptPath, packetPath, approvalsPath, dispatchPath, auditPath, '--send', ...extraFlags],
      { encoding: 'utf8', env: { ...process.env, PATH_SEND_TRANSPORT: 'fake', ...env } });
    return { dir, result, dispatchPath };
  }

  test('--send dispatches an approved packet and appends dispatch_completed', () => {
    const packet = makePacket();
    const { result, dispatchPath } = runSendCli(packet);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.mode, 'send');
    assert.equal(out.status, 'DISPATCHED');
    assert.equal(out.packetId, packet.id);
    assert.equal(out.tier, 'YELLOW');
    assert.match(out.messageId, /^fake-/);

    const lines = fs.readFileSync(dispatchPath, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.packetId, packet.id);
    assert.equal(record.event, 'dispatch_completed');
    assert.equal(record.providerId, 'gmail');
    assert.equal(record.messageId, out.messageId);
  });

  test('send failure returns SEND_FAILED_* and leaves the ledger untouched', () => {
    const packet = makePacket();
    const { result, dispatchPath } = runSendCli(packet, { env: { PATH_SEND_FAKE_FAIL: '1' } });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, 'SEND_FAILED_API');
    assert.equal(fs.readFileSync(dispatchPath, 'utf8'), '');
  });

  test('rejected packet is blocked by the gate before any transport call', () => {
    const packet = makePacket();
    const { result, dispatchPath } = runSendCli(packet, { decision: 'REJECTED' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_REJECTED');
    assert.equal(fs.readFileSync(dispatchPath, 'utf8'), '');
  });

  test('already-dispatched packet is refused (idempotency)', () => {
    const packet = makePacket();
    const { result, dispatchPath } = runSendCli(packet, {
      dispatches: [{ packetId: packet.id, event: 'dispatch_completed', messageId: 'old' }]
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_ALREADY_DISPATCHED');
    assert.equal(fs.readFileSync(dispatchPath, 'utf8').split(/\r?\n/).filter(Boolean).length, 1);
  });

  test('--send requires exactly one recognized flag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-send-'));
    const packetPath = path.join(dir, 'packet.json');
    fs.writeFileSync(packetPath, JSON.stringify({ id: 'packet-1' }), 'utf8');
    const result = spawnSync(process.execPath, [scriptPath, packetPath], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--send/);
    assert.match(result.stderr, /--dry-run/);
  });
  ```

- [ ] **Step 2: Run the integration test to verify it fails**

  Run: `node --test tests/path-safety/dispatch-send.test.mjs`
  Expected: FAIL — the CLI still hard-requires `--dry-run` (exit 2), so voice the `DISPATCHED` assertions never pass.

- [ ] **Step 3: Implement the `--send` mode in `scripts/path-dispatch.mjs`**

  Apply in order:

  1. **Add imports** (replace lines 1-5):

  ```js
  import crypto from 'node:crypto';
  import fs from 'node:fs';
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  import { verifyAuditLedger } from '../path-safety/audit-ledger.mjs';
  import { verifyPacketIntegrity } from '../path-safety/packet-integrity.mjs';
  ```

  2. **Add helpers** directly after `parseJsonl` (after line 76):

  ```js
  const USAGE = 'Usage: node scripts/path-dispatch.mjs <packet.json> <approvals.jsonl> <dispatch.jsonl> <audit.jsonl> --dry-run|--send';

  function codedError(code, cause) {
    return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
  }

  // Idempotent lazy dotenv load; mirrors plugins/_engine.mjs. Credentials only
  // matter on the real (non-fake) send path, so this may stay a no-op in absensce.
  let dotenvLoaded = false;
  async function loadDotenvOnce() {
    if (dotenvLoaded) return;
    dotenvLoaded = true;
    try {
      const { config } = await import('dotenv');
      config();
    } catch {
      // dotenv optional — fall back to ambient process.env.
    }
  }

  // Subprocess seam: PATH_SEND_TRANSPORT=fake routes to an in-script fake so
  // integration tests exercise the full gate/send/ledger host without OAuth.
  // PATH_SEND_FAKE_FAIL=1 forces a failure for the failure test.
  async function resolveSendTransport() {
    if (process.env.PATH_SEND_TRANSPORT === 'fake') {
      return {
        async sendGmailMessage() {
          if (process.env.PATH_SEND_FAKE_FAIL === '1') throw codedError('SEND_FAILED_API');
          return { ok: true, messageId: `fake-${crypto.randomUUID()}` };
        }
      };
    }
    await loadDotenvOnce();
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) throw codedError('SEND_FAILED_CONFIG');
    const { sendGmailMessage } = await import('../transports/gmail-send.mjs');
    return {
      sendGmailMessage: (args) => sendGmailMessage({ ...args, clientId, clientSecret, refreshToken })
    };
  }

  // Missing dispatch file is an empty ledger on the send path (lazy append-only);
  // a malformed existing file still fails loudly via parseJsonl.
  function readDispatches(dispatchPath) {
    if (!fs.existsSync(dispatchPath)) return [];
    return parseJsonl(dispatchPath);
  }

  // Sends and appends the receipt only after the transport confirms a messageId.
  // Runs after evaluateDryRun() returned READY_TO_DISPATCH, so the send is
  // twice-gated: same gate in the same run that performs the send.
  async function performSend({ packet, dispatchPath }) {
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
      const record = {
        packetId: packet.id,
        event: 'dispatch_completed',
        timestamp: new Date().toISOString(),
        messageId: result.messageId,
        providerId: 'gmail'
      };
      fs.mkdirSync(path.dirname(dispatchPath), { recursive: true });
      fs.appendFileSync(dispatchPath, `${JSON.stringify(record)}\n`, 'utf8');
      return { status: 'DISPATCHED', messageId: result.messageId };
    } catch (error) {
      return { status: error?.code || 'SEND_FAILED_HTTP' };
    }
  }
  ```

  3. **Update `printResult`** (replace existing lines ~78-86):

  ```js
  function printResult(status, packet = {}, { mode = 'dry-run', extras = {} } = {}) {
    console.log(JSON.stringify({
      mode,
      status,
      packetId: packet?.id ?? null,
      tier: packet?.tier ?? null,
      ...extras
    }, null, 2));
    return status === 'READY_TO_DISPATCH' || status === 'DISPATCHED' ? 0 : 1;
  }
  ```

  4. **Rewrite `main`** (replace existing `main` + the CLI guard at the bottom):

  ```js
  async function main(args) {
    const [packetPath, approvalsPath, dispatchPath, auditPath, ...flags] = args;
    if (!packetPath || !approvalsPath || !dispatchPath || !auditPath ||
        flags.length !== 1 || !['--dry-run', '--send'].includes(flags[0])) {
      console.error(USAGE);
      return 2;
    }
    const isSend = flags[0] === '--send';

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

    const gate = evaluateDryRun({ packet, approvals, dispatches, auditPath });
    if (isSend) {
      if (gate.status !== 'READY_TO_DISPATCH') {
        return printResult(gate.status, packet, { mode: 'send' });
      }
      const outcome = await performSend({ packet, dispatchPath });
      return printResult(outcome.status, packet, {
        mode: 'send',
        extras: outcome.messageId ? { messageId: outcome.messageId } : {}
      });
    }
    return printResult(gate.status, packet);
  }

  if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main(process.argv.slice(2)).then((code) => process.exit(code));
  }
  ```

  Do **not** change `evaluateDryRun` or `gateOnAuditLedger`. The existing `--dry-run` output shape (`{ mode: 'dry-run', status, packetId, tier }`) must stay byte-identical so `tests/path-safety/dispatch.test.mjs` deep-equals still pass.

- [ ] **Step 4: Run both test suites**

  Run: `npm run test:path-safety`
  Expected:
  - `dispatch-send.test.mjs`: all 5 PASS.
  - `dispatch.test.mjs` (existing, untouched): all PASS (esp. `approved packet is ready in dry-run without writing dispatch state` and `dry-run blocks rejected...`).

- [ ] **Step 5: Smoke-test the CLI by hand (dry-run unchanged)**

  Run one of the current `--dry-run` invocations against the fixture from `tests/path-safety/dispatch.test.mjs` (or any temp dir as in that file).
  Expected: JSON `{ "mode": "dry-run", "status": "READY_TO_DISPATCH", ... }` or a `BLOCKED_*` status — identical behavior to before this task.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/path-dispatch.mjs tests/path-safety/dispatch-send.test.mjs
  git commit -m "feat(path-dispatch): add --send mode behind the existing approval gate"
  ```

  Verify the diff contains exactly: `scripts/path-dispatch.mjs`, `tests/path-safety/dispatch-send.test.mjs`. `git status --short` clean after.

---

### Task 3: Docs + fixture ledger file

**Files:**
- Create: `data/path-dispatch.jsonl` (empty file)
- Modify: `.env.example` (gmail plugin block, add a send-path note)

**Interfaces:**
- Consumes: the `GMAIL_*` names already documented in `.env.example` (lines ~53-58).
- Produces: an on-disk empty dispatch ledger so a first `--send` against the default repo path works with no prep; a one-line pointer to `scripts/path-dispatch.mjs --send` in `.env.example`.

- [ ] **Step 1: Create the empty ledger**

  Run:
  ```powershell
  New-Item -ItemType File -Path "C:\Users\van1h\Documents\GitHub\Path\data\path-dispatch.jsonl"
  ```
  The file must exist and be empty (0 bytes). Do not add a record — dispatch state accrues at runtime.

- [ ] **Step 2: Document the send path in `.env.example`**

  Append to the gmail plugin block in `.env.example`:

  ```text
  # The same three variables are reused by scripts/path-dispatch.mjs --send
  # (outbound). The CLI loads them lazily via dotenv only on the real send path.
  ```

- [ ] **Step 3: Run the full path-safety suite**

  Run: `node --test tests/path-safety/*.test.mjs`
  Expected: all PASS (existing + new suites).

- [ ] **Step 4: Commit**

  ```bash
  git add data/path-dispatch.jsonl .env.example
  git commit -m "docs(dispatch): note --send credentials and add empty dispatch ledger fixture"
  ```

- [ ] **Step 5: End-to-end smoke (fake transport only)**

  Craft a temp dispatch fixture (packet + approvals + audit) exactly as in `tests/path-safety/dispatch.test.mjs`, then run the send against it with the fake seam so no real mail is sent:

  ```powershell
  $env:PATH_SEND_TRANSPORT="fake"
  node scripts/path-dispatch.mjs <temp>/packet.json <temp>/approvals.jsonl <temp>/dispatch.jsonl <temp>/audit.jsonl --send
  ```

  Expected: exit 0, `{ "mode": "send", "status": "DISPATCHED", ... }`, and one `dispatch_completed` line appended to `<temp>/dispatch.jsonl`. Do **not** run without the fake seam in any test. A second identical invocation must be refused with `BLOCKED_ALREADY_DISPATCHED`.

---

## Self-Review

**Spec coverage cross-check** (`docs/superpowers/specs/2026-08-08-gmail-send-design.md`):

| Spec requirement | Where |
| --- | --- |
| New pure transport `transports/gmail-send.mjs` (OAuth refresh + send, raw fetch, no deps) | Task 1 |
| `--send` shares same `evaluateDryRun()` gate in the same run | Task 2 step 3 `main` |
| Subject derived from `action.opportunity` | Task 2 `performSend` |
| `send` is text-only, no attachments | Task 1 transport, `text/plain` |
| `dispatch_completed` appended only after 2xx + messageId | Task 2 `performSend` |
| Dedupe by `packetId` → `BLOCKED_ALREADY_DISPATCHED` | unchanged gate + test |
| Failure prints `SEND_FAILED_*`, exits 1, no ledger write | Task 2 tests + `performSend` |
| `dispatch_completed` not in `EVENT_RULES`, dispatch-ledger-only | Global Constraint + `providerId` record |
| Zero new package deps | Global Constraint |
| `data/path-dispatch.jsonl` created (was referenced-absent) | Task 3 |
| `.env` / `.env.example` document the outbound creds | Task 3 |

**Placeholder scan:** no TBD/TODO steps; every step has concrete file content. The three `codedError` paths in the transport map to the three spec failure codes, and the fake seam maps to the two integration outcomes in the spec's Testing strategy.

**Type consistency:** `sendGmailMessage` returns `{ ok: true, messageId }`; the fake returns the same shape; `performSend` returns `{ status, messageId? }`; `printResult(status, packet, { mode, extras })`. Ledger shape `{ packetId, event, timestamp, messageId, providerId }` is identical in `performSend` and in the integration assertions. `readDispatches` mirrors `parseJsonl`'s behavior for the missing-file case only on the send path, keeping dry-run semantics untouched.