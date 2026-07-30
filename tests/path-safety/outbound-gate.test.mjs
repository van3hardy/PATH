import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendAuditRecord, verifyAuditLedger } from '../../path-safety/audit-ledger.mjs';
import { buildApprovalPacket } from '../../path-safety/approval-packet.mjs';
import { gateOutbound, reconcileOutboxAudit } from '../../path-safety/outbound-gate.mjs';
import { loadFacts } from '../../path-safety/fact-resolver.mjs';
import { sha256Hex, stableStringify } from '../../path-safety/packet-integrity.mjs';

const approvedSentence = 'Van builds agent workflows on Windows 11 with PowerShell.';

function supportedInput(overrides = {}) {
  return {
    runId: 'run-1',
    action: { type: 'send_email', channel: 'gmail', touch: 'first' },
    opportunity: { company: 'Example Company', role: 'AI Engineer' },
    recipient: { name: 'Hiring Manager', address: 'hm@example.com' },
    text: `Hello. ${approvedSentence} Path is Van's AI recruiting assistant.`,
    claims: [approvedSentence],
    facts: loadFacts('config/path.facts.yml'),
    evidenceIds: ['van-agent-workflows-windows-powershell'],
    evidenceHashes: ['a'.repeat(64)],
    claimReportHash: 'b'.repeat(64),
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    disclosureIncluded: true,
    promptVersion: 'path-recruiter-v1',
    provider: 'fake',
    model: 'deterministic-recruiter-template-v1',
    ...overrides
  };
}

function tempPaths(prefix = 'path-gate-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    outboxPath: path.join(dir, 'outbox.jsonl'),
    auditPath: path.join(dir, 'audit.jsonl')
  };
}

test('GREEN action is allowed without outbox queue', () => {
  const paths = tempPaths('path-green-');
  const result = gateOutbound(supportedInput({
    action: { type: 'discover_roles', channel: 'internal' }
  }), paths, { now: () => new Date('2026-07-29T12:00:00.000Z') });

  assert.equal(result.decision, 'ALLOW_GREEN');
  assert.equal(fs.existsSync(paths.outboxPath), false);
});

test('YELLOW action is queued only after complete attempted and queued audits', () => {
  const paths = tempPaths('path-yellow-');
  const result = gateOutbound(supportedInput(), paths, {
    now: () => new Date('2026-07-29T12:00:00.000Z')
  });

  assert.equal(result.decision, 'QUEUE_FOR_APPROVAL');
  const queued = JSON.parse(fs.readFileSync(paths.outboxPath, 'utf8').trim());
  assert.equal(queued.status, 'AWAITING_VAN_APPROVAL');
  assert.equal(queued.policyVersion, 'path-safety-v1');
  assert.match(queued.integritySha256, /^[a-f0-9]{64}$/);
  assert.match(queued.idempotencyKey, /^[a-f0-9]{24}$/);
  assert.equal(queued.id, queued.integritySha256.slice(0, 16));
  const events = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((entry) => entry.event), [
    'approval_packet_queue_attempted',
    'approval_packet_queued'
  ]);
  assert.equal(events[0].finalText, queued.finalText);
  assert.deepEqual(events[1].action.opportunity, queued.action.opportunity);
  assert.equal(events[1].previousHash, events[0].recordHash);
  assert.equal(verifyAuditLedger(paths.auditPath).ok, true);
});

test('invalid evidence is blocked before audit or outbox mutation', () => {
  for (const overrides of [
    { evidenceIds: undefined },
    { evidenceIds: null },
    { evidenceIds: 'fact-1' },
    { evidenceIds: [], evidenceHashes: [] },
    { evidenceHashes: [] },
    { evidenceHashes: ['not-a-hash'] }
  ]) {
    const paths = tempPaths('path-invalid-packet-');
    assert.throws(() => gateOutbound(supportedInput(overrides), paths), {
      code: 'BLOCKED_INVALID_PACKET'
    });
    assert.equal(fs.existsSync(paths.auditPath), false);
    assert.equal(fs.existsSync(paths.outboxPath), false);
  }
});

test('unsupported claims are blocked without an approval packet', () => {
  const paths = tempPaths('path-unsupported-');
  const result = gateOutbound(supportedInput({
    claims: ['Van led recruiting at a Fortune 100 company.']
  }), paths);

  assert.equal(result.decision, 'BLOCK_UNSUPPORTED_CLAIMS');
  assert.equal(result.packet, null);
  assert.equal(fs.existsSync(paths.outboxPath), false);
  const audit = JSON.parse(fs.readFileSync(paths.auditPath, 'utf8').trim());
  assert.equal(audit.event, 'unsupported_claims_blocked');
  assert.equal(audit.decision, 'BLOCKED_UNSUPPORTED_CLAIMS');
  assert.equal(audit.finalText, supportedInput().text);
  assert.deepEqual(audit.action.opportunity, supportedInput().opportunity);
});

test('unsupported first-touch input without opportunity is invalid and creates no records', () => {
  const paths = tempPaths('path-unsupported-invalid-context-');
  assert.throws(() => gateOutbound(supportedInput({
    opportunity: undefined,
    claims: ['Van led recruiting at a Fortune 100 company.']
  }), paths), { code: 'BLOCKED_INVALID_PACKET' });
  assert.equal(fs.existsSync(paths.auditPath), false);
  assert.equal(fs.existsSync(paths.outboxPath), false);
});

test('same proposal cannot be queued twice with a new timestamp', () => {
  const paths = tempPaths('path-duplicate-');
  const first = gateOutbound(supportedInput(), paths, {
    now: () => new Date('2026-07-29T12:00:00Z')
  });
  const second = gateOutbound(supportedInput(), paths, {
    now: () => new Date('2026-07-29T12:01:00Z')
  });
  assert.equal(first.decision, 'QUEUE_FOR_APPROVAL');
  assert.equal(second.decision, 'BLOCK_DUPLICATE_PROPOSAL');
  assert.equal(fs.readFileSync(paths.outboxPath, 'utf8').trim().split('\n').length, 1);
  const events = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).event, 'duplicate_proposal_blocked');
});

test('audit failure prevents outbox append', () => {
  const paths = tempPaths('path-audit-fail-');
  assert.throws(() => gateOutbound(supportedInput(), paths, {
    appendAudit: () => { throw Object.assign(new Error('audit failed'), { code: 'FAILED_AUDIT_WRITE' }); }
  }), { code: 'FAILED_AUDIT_WRITE' });
  assert.equal(fs.existsSync(paths.outboxPath), false);
});

test('outbox failure is audited and throws FAILED_OUTBOX_WRITE', () => {
  const paths = tempPaths('path-outbox-fail-');
  fs.writeFileSync(paths.outboxPath, '', 'utf8');
  let auditCalls = 0;
  assert.throws(() => gateOutbound(supportedInput(), paths, {
    appendAudit: (auditPath, record, options) => {
      auditCalls += 1;
      if (auditCalls === 1) {
        fs.unlinkSync(paths.outboxPath);
        fs.mkdirSync(paths.outboxPath);
      }
      return appendAuditRecord(auditPath, record, options);
    }
  }), { code: 'FAILED_OUTBOX_WRITE' });
  const events = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((entry) => entry.event), [
    'approval_packet_queue_attempted',
    'approval_packet_queue_failed'
  ]);
});

test('queued-audit failure leaves a reconcilable unresolved packet', () => {
  const paths = tempPaths('path-queue-audit-fail-');
  let auditCalls = 0;
  assert.throws(() => gateOutbound(supportedInput(), paths, {
    appendAudit: (auditPath, record, options) => {
      auditCalls += 1;
      if (auditCalls === 2) {
        throw Object.assign(new Error('final audit failed'), { code: 'FAILED_AUDIT_WRITE' });
      }
      return appendAuditRecord(auditPath, record, options);
    }
  }), { code: 'UNRESOLVED_QUEUE_AUDIT' });

  const before = fs.readFileSync(paths.outboxPath, 'utf8');
  const result = reconcileOutboxAudit(paths.outboxPath, paths.auditPath);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNRESOLVED_QUEUE_AUDIT');
  assert.equal(result.packetIds.length, 1);
  assert.equal(fs.readFileSync(paths.outboxPath, 'utf8'), before);
});

test('reconciliation rejects a same-ID queued audit with all mutable bindings changed', () => {
  const paths = tempPaths('path-reconcile-mismatch-');
  gateOutbound(supportedInput(), paths, {
    now: () => new Date('2026-07-29T12:00:00.000Z')
  });
  const entries = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  const queued = entries.at(-1);
  queued.integritySha256 = 'f'.repeat(64);
  queued.idempotencyKey = 'c'.repeat(24);
  queued.action = {
    type: 'send_linkedin', channel: 'linkedin', touch: 'followup',
    opportunity: { company: 'Other Company', role: 'Staff Engineer' }
  };
  queued.recipient = { ...queued.recipient, address: 'other@example.com' };
  queued.finalText = 'Different exact final text.';
  queued.finalTextSha256 = sha256Hex(queued.finalText);
  queued.evidenceIds = ['other-fact'];
  queued.evidenceHashes = ['d'.repeat(64)];
  queued.claimReportHash = 'e'.repeat(64);
  const { recordHash: ignored, ...withoutHash } = queued;
  queued.recordHash = sha256Hex(stableStringify(withoutHash));
  fs.writeFileSync(paths.auditPath, `${entries.map(JSON.stringify).join('\n')}\n`, 'utf8');

  const beforeOutbox = fs.readFileSync(paths.outboxPath, 'utf8');
  const beforeAudit = fs.readFileSync(paths.auditPath, 'utf8');
  assert.deepEqual(reconcileOutboxAudit(paths.outboxPath, paths.auditPath), {
    ok: false, code: 'UNRESOLVED_QUEUE_AUDIT', packetIds: [JSON.parse(beforeOutbox).id]
  });
  assert.equal(fs.readFileSync(paths.outboxPath, 'utf8'), beforeOutbox);
  assert.equal(fs.readFileSync(paths.auditPath, 'utf8'), beforeAudit);
});

test('reconciliation rejects duplicate exact queued audit events', () => {
  const paths = tempPaths('path-reconcile-duplicate-');
  gateOutbound(supportedInput(), paths, {
    now: () => new Date('2026-07-29T12:00:00.000Z')
  });
  const entries = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  const queued = entries.at(-1);
  const callerRecord = { ...queued };
  for (const field of ['schemaVersion', 'timestamp', 'finalTextSha256', 'previousHash', 'recordHash']) {
    delete callerRecord[field];
  }
  appendAuditRecord(paths.auditPath, callerRecord, {
    now: () => new Date('2026-07-29T12:00:01.000Z')
  });

  const beforeOutbox = fs.readFileSync(paths.outboxPath, 'utf8');
  const beforeAudit = fs.readFileSync(paths.auditPath, 'utf8');
  assert.deepEqual(reconcileOutboxAudit(paths.outboxPath, paths.auditPath), {
    ok: false, code: 'UNRESOLVED_QUEUE_AUDIT', packetIds: [JSON.parse(beforeOutbox).id]
  });
  assert.equal(fs.readFileSync(paths.outboxPath, 'utf8'), beforeOutbox);
  assert.equal(fs.readFileSync(paths.auditPath, 'utf8'), beforeAudit);
});

test('reconciliation rejects duplicate identical outbox records with one queued event', () => {
  const paths = tempPaths('path-reconcile-duplicate-outbox-');
  gateOutbound(supportedInput(), paths, {
    now: () => new Date('2026-07-29T12:00:00.000Z')
  });
  const line = fs.readFileSync(paths.outboxPath, 'utf8').trim();
  const packet = JSON.parse(line);
  fs.appendFileSync(paths.outboxPath, `${line}\n`, 'utf8');

  const beforeOutbox = fs.readFileSync(paths.outboxPath, 'utf8');
  const beforeAudit = fs.readFileSync(paths.auditPath, 'utf8');
  assert.deepEqual(reconcileOutboxAudit(paths.outboxPath, paths.auditPath), {
    ok: false, code: 'UNRESOLVED_QUEUE_AUDIT', packetIds: [packet.id]
  });
  assert.equal(fs.readFileSync(paths.outboxPath, 'utf8'), beforeOutbox);
  assert.equal(fs.readFileSync(paths.auditPath, 'utf8'), beforeAudit);
});

test('reconciliation rejects distinct valid outbox records sharing idempotency', () => {
  const paths = tempPaths('path-reconcile-duplicate-idempotency-');
  gateOutbound(supportedInput(), paths, {
    now: () => new Date('2026-07-29T12:00:00.000Z')
  });
  const second = buildApprovalPacket(supportedInput(), {
    now: () => new Date('2026-07-29T12:01:00.000Z')
  });
  const first = JSON.parse(fs.readFileSync(paths.outboxPath, 'utf8').trim());
  assert.notEqual(first.id, second.id);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  fs.appendFileSync(paths.outboxPath, `${JSON.stringify(second)}\n`, 'utf8');

  const queued = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  const secondQueued = {
    ...queued,
    packetId: second.id,
    integritySha256: second.integritySha256,
    idempotencyKey: second.idempotencyKey,
    action: second.action,
    recipient: second.recipient,
    finalText: second.finalText,
    evidenceIds: second.evidenceIds,
    evidenceHashes: second.evidenceHashes,
    claimReportHash: second.claimReportHash,
    tier: second.tier,
    policyVersion: second.policyVersion,
    voiceProfile: second.voiceProfile,
    disclosurePolicy: second.disclosurePolicy,
    disclosureIncluded: second.disclosureIncluded,
    provider: second.provider,
    model: second.model,
    promptVersion: second.promptVersion
  };
  for (const field of ['schemaVersion', 'timestamp', 'finalTextSha256', 'previousHash', 'recordHash']) {
    delete secondQueued[field];
  }
  appendAuditRecord(paths.auditPath, secondQueued, {
    now: () => new Date('2026-07-29T12:01:01.000Z')
  });

  const beforeOutbox = fs.readFileSync(paths.outboxPath, 'utf8');
  const beforeAudit = fs.readFileSync(paths.auditPath, 'utf8');
  const result = reconcileOutboxAudit(paths.outboxPath, paths.auditPath);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNRESOLVED_QUEUE_AUDIT');
  assert.deepEqual(result.packetIds.sort(), [first.id, second.id].sort());
  assert.equal(fs.readFileSync(paths.outboxPath, 'utf8'), beforeOutbox);
  assert.equal(fs.readFileSync(paths.auditPath, 'utf8'), beforeAudit);
});

test('reconciliation rejects unmatched extra queued audit events', () => {
  const paths = tempPaths('path-reconcile-extra-audit-');
  gateOutbound(supportedInput(), paths, {
    now: () => new Date('2026-07-29T12:00:00.000Z')
  });
  const extra = buildApprovalPacket(supportedInput({
    opportunity: { company: 'Other Company', role: 'Staff Engineer' }
  }), { now: () => new Date('2026-07-29T12:01:00.000Z') });
  const queued = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  const extraQueued = {
    ...queued,
    packetId: extra.id,
    integritySha256: extra.integritySha256,
    idempotencyKey: extra.idempotencyKey,
    action: extra.action,
    recipient: extra.recipient,
    finalText: extra.finalText,
    evidenceIds: extra.evidenceIds,
    evidenceHashes: extra.evidenceHashes,
    claimReportHash: extra.claimReportHash
  };
  for (const field of ['schemaVersion', 'timestamp', 'finalTextSha256', 'previousHash', 'recordHash']) {
    delete extraQueued[field];
  }
  appendAuditRecord(paths.auditPath, extraQueued, {
    now: () => new Date('2026-07-29T12:01:01.000Z')
  });

  const beforeOutbox = fs.readFileSync(paths.outboxPath, 'utf8');
  const beforeAudit = fs.readFileSync(paths.auditPath, 'utf8');
  assert.deepEqual(reconcileOutboxAudit(paths.outboxPath, paths.auditPath), {
    ok: false, code: 'UNRESOLVED_QUEUE_AUDIT', packetIds: [extra.id]
  });
  assert.equal(fs.readFileSync(paths.outboxPath, 'utf8'), beforeOutbox);
  assert.equal(fs.readFileSync(paths.auditPath, 'utf8'), beforeAudit);
});

test('malformed existing outbox blocks without mutation', () => {
  const paths = tempPaths('path-outbox-malformed-');
  fs.writeFileSync(paths.outboxPath, '{not-json\n', 'utf8');
  assert.throws(() => gateOutbound(supportedInput(), paths), { code: 'FAILED_OUTBOX_READ' });
  assert.equal(fs.readFileSync(paths.outboxPath, 'utf8'), '{not-json\n');
});

test('non-object JSONL outbox entry is malformed and blocks', () => {
  const paths = tempPaths('path-outbox-non-object-');
  fs.writeFileSync(paths.outboxPath, 'null\n', 'utf8');
  assert.throws(() => gateOutbound(supportedInput(), paths), { code: 'FAILED_OUTBOX_READ' });
  assert.equal(fs.readFileSync(paths.outboxPath, 'utf8'), 'null\n');
});

test('RED action remains manual-only and is never queued', () => {
  const paths = tempPaths('path-red-');
  const result = gateOutbound(supportedInput({
    text: `I accept the offer. ${approvedSentence}`
  }), paths);

  assert.equal(result.decision, 'BLOCK_RED');
  assert.equal(result.packet.tier, 'RED');
  assert.equal(fs.existsSync(paths.outboxPath), false);
  const audit = JSON.parse(fs.readFileSync(paths.auditPath, 'utf8').trim());
  assert.equal(audit.event, 'red_action_blocked');
});
