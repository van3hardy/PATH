import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendAuditRecord, verifyAuditLedger } from '../../path-safety/audit-ledger.mjs';
import { sha256Hex, stableStringify } from '../../path-safety/packet-integrity.mjs';

function auditRecord(overrides = {}) {
  return {
    event: 'approval_packet_queue_attempted',
    runId: 'run-1',
    packetId: 'a'.repeat(16),
    integritySha256: 'e'.repeat(64),
    idempotencyKey: 'b'.repeat(24),
    action: {
      type: 'send_email', channel: 'email', touch: 'first',
      opportunity: { company: 'Example Company', role: 'AI Engineer' }
    },
    recipient: { name: 'Hiring Manager', address: 'hm@example.test' },
    finalText: 'Exact final text.',
    evidenceIds: ['fact-1'],
    evidenceHashes: ['c'.repeat(64)],
    claimReportHash: 'd'.repeat(64),
    tier: 'YELLOW',
    policyVersion: 'path-safety-v1',
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    disclosureIncluded: true,
    provider: 'fake',
    model: 'deterministic-recruiter-template-v1',
    promptVersion: 'path-recruiter-v1',
    decision: 'QUEUE_FOR_APPROVAL',
    ...overrides
  };
}

function tempAuditPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-audit-'));
  return path.join(dir, 'audit.jsonl');
}

test('appendAuditRecord writes two complete hash-chained JSONL records', () => {
  const auditPath = tempAuditPath();
  const first = appendAuditRecord(auditPath, auditRecord(), {
    now: () => new Date('2026-07-29T12:00:00.000Z')
  });
  const second = appendAuditRecord(auditPath, auditRecord({
    event: 'approval_packet_queued',
    decision: 'LOCAL_REVIEW_READY'
  }), { now: () => new Date('2026-07-29T12:00:01.000Z') });

  assert.equal(first.schemaVersion, 'path.audit.v1');
  assert.equal(first.previousHash, 'GENESIS');
  assert.equal(first.finalTextSha256, sha256Hex('Exact final text.'));
  assert.match(first.recordHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.action.opportunity, {
    company: 'Example Company', role: 'AI Engineer'
  });
  assert.equal(second.previousHash, first.recordHash);
  assert.deepEqual(verifyAuditLedger(auditPath), {
    ok: true,
    code: 'AUDIT_LEDGER_OK',
    recordCount: 2,
    lastRecordHash: second.recordHash
  });
});

test('verifyAuditLedger detects changed content', () => {
  const auditPath = tempAuditPath();
  appendAuditRecord(auditPath, auditRecord());
  const entry = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  entry.decision = 'TAMPERED';
  fs.writeFileSync(auditPath, `${JSON.stringify(entry)}\n`, 'utf8');

  assert.deepEqual(verifyAuditLedger(auditPath), {
    ok: false,
    code: 'FAILED_AUDIT_HASH',
    recordIndex: 0
  });
});

test('verifyAuditLedger detects a broken previous hash even when record hash is recomputed', () => {
  const auditPath = tempAuditPath();
  appendAuditRecord(auditPath, auditRecord());
  appendAuditRecord(auditPath, auditRecord({
    event: 'approval_packet_queued', decision: 'LOCAL_REVIEW_READY'
  }));
  const entries = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  entries[1].previousHash = 'e'.repeat(64);
  const { recordHash: ignored, ...withoutHash } = entries[1];
  entries[1].recordHash = sha256Hex(stableStringify(withoutHash));
  fs.writeFileSync(auditPath, `${entries.map(JSON.stringify).join('\n')}\n`, 'utf8');

  assert.deepEqual(verifyAuditLedger(auditPath), {
    ok: false,
    code: 'FAILED_AUDIT_CHAIN',
    recordIndex: 1
  });
});

test('verifyAuditLedger detects malformed JSONL', () => {
  const auditPath = tempAuditPath();
  fs.writeFileSync(auditPath, '{not-json\n', 'utf8');
  assert.deepEqual(verifyAuditLedger(auditPath), {
    ok: false,
    code: 'FAILED_AUDIT_MALFORMED',
    recordIndex: 0
  });
});

test('verifyAuditLedger detects truncation against caller anchor', () => {
  const auditPath = tempAuditPath();
  const first = appendAuditRecord(auditPath, auditRecord());
  const second = appendAuditRecord(auditPath, auditRecord({
    event: 'approval_packet_queued', decision: 'LOCAL_REVIEW_READY'
  }));
  fs.writeFileSync(auditPath, `${JSON.stringify(first)}\n`, 'utf8');

  assert.deepEqual(verifyAuditLedger(auditPath, {
    expectedLastRecordHash: second.recordHash
  }), {
    ok: false,
    code: 'FAILED_AUDIT_TRUNCATED',
    recordCount: 1,
    lastRecordHash: first.recordHash
  });
});

test('expected audit anchor remains valid after verified chain extension', () => {
  const auditPath = tempAuditPath();
  const first = appendAuditRecord(auditPath, auditRecord());
  const second = appendAuditRecord(auditPath, auditRecord({
    event: 'approval_packet_queued', decision: 'LOCAL_REVIEW_READY'
  }));

  assert.deepEqual(verifyAuditLedger(auditPath, {
    expectedLastRecordHash: first.recordHash
  }), {
    ok: true,
    code: 'AUDIT_LEDGER_OK',
    recordCount: 2,
    lastRecordHash: second.recordHash
  });
});

test('missing audit anchor is reported as truncation', () => {
  const auditPath = tempAuditPath();
  const first = appendAuditRecord(auditPath, auditRecord());
  assert.deepEqual(verifyAuditLedger(auditPath, {
    expectedLastRecordHash: 'f'.repeat(64)
  }), {
    ok: false,
    code: 'FAILED_AUDIT_TRUNCATED',
    recordCount: 1,
    lastRecordHash: first.recordHash
  });
});

test('appendAuditRecord rejects incomplete and invented records before write', () => {
  const invalid = [
    ['array record', []],
    ['invented event', auditRecord({ event: 'made_up_event' })],
    ['invented decision', auditRecord({ decision: 'MAYBE' })],
    ['missing final text', (() => {
      const record = auditRecord();
      delete record.finalText;
      return record;
    })()],
    ['array action', auditRecord({ action: [] })],
    ['array recipient', auditRecord({ recipient: [] })],
    ['mismatched evidence', auditRecord({ evidenceHashes: [] })],
    ['unknown provider', auditRecord({ provider: 'arbitrary' })],
    ['packet event without opportunity', auditRecord({
      action: { type: 'send_email', channel: 'email', touch: 'first' }
    })],
    ['packet event null final text', auditRecord({ finalText: null })],
    ['no-model provider on packet event', auditRecord({ provider: 'none', model: 'none' })]
  ];

  for (const [name, record] of invalid) {
    const auditPath = tempAuditPath();
    assert.throws(() => appendAuditRecord(auditPath, record), {
      code: 'FAILED_AUDIT_SCHEMA'
    }, name);
    assert.equal(fs.existsSync(auditPath), false, name);
  }
});

test('unsupported diagnostic explicitly carries null packet bindings and no-model versions', () => {
  const auditPath = tempAuditPath();
  const record = auditRecord({
    event: 'unsupported_claims_blocked',
    packetId: null,
    integritySha256: null,
    idempotencyKey: null,
    tier: null,
    provider: 'none',
    model: 'none',
    decision: 'BLOCKED_UNSUPPORTED_CLAIMS'
  });
  const appended = appendAuditRecord(auditPath, record);
  assert.equal(appended.packetId, null);
  assert.equal(appended.integritySha256, null);
  assert.equal(appended.idempotencyKey, null);
  assert.equal(appended.tier, null);
  assert.equal(verifyAuditLedger(auditPath).ok, true);
});

test('unsupported diagnostic without canonical opportunity is rejected before append', () => {
  const auditPath = tempAuditPath();
  assert.throws(() => appendAuditRecord(auditPath, auditRecord({
    event: 'unsupported_claims_blocked',
    packetId: null,
    integritySha256: null,
    idempotencyKey: null,
    action: { type: 'send_email', channel: 'email', touch: 'first' },
    tier: null,
    provider: 'none',
    model: 'none',
    decision: 'BLOCKED_UNSUPPORTED_CLAIMS'
  })), { code: 'FAILED_AUDIT_SCHEMA' });
  assert.equal(fs.existsSync(auditPath), false);
});

test('green_action_allowed is an accepted event with its exact decision', () => {
  const auditPath = tempAuditPath();
  appendAuditRecord(auditPath, auditRecord({
    event: 'green_action_allowed',
    tier: 'GREEN',
    decision: 'ALLOW_GREEN'
  }));
  assert.equal(verifyAuditLedger(auditPath).ok, true);
});
