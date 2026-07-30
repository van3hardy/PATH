import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  createRun,
  finishRun,
  transitionRun
} from '../../path-runner/lifecycle.mjs';
import {
  appendAuditRecord,
  recordApprovalDecision,
  verifyAuditLedger
} from '../../path-safety/audit-ledger.mjs';
import { buildPacketIntegrityFields } from '../../path-safety/packet-integrity.mjs';

const scriptPath = path.resolve('scripts/path-approve.mjs');

function makePacket(overrides = {}) {
  const createdAt = new Date().toISOString();
  const base = {
    action: {
      type: 'send_email', channel: 'email', touch: 'first',
      opportunity: { company: 'Example Company', role: 'AI Engineer' }
    },
    recipient: { name: 'Hiring Manager', address: 'hm@example.test' },
    finalText: 'Exact approved draft.',
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
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString(),
    status: 'AWAITING_VAN_APPROVAL',
    tier: 'YELLOW',
    ...overrides
  };
  return { ...base, ...buildPacketIntegrityFields(base) };
}

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-approval-'));
  return {
    dir,
    approvalsPath: path.join(dir, 'approvals.jsonl'),
    auditPath: path.join(dir, 'audit.jsonl')
  };
}

test('approved and rejected decisions bind the exact verified packet', () => {
  for (const decision of ['APPROVED', 'REJECTED']) {
    const paths = tempPaths();
    const packet = makePacket();
    const result = recordApprovalDecision(paths, packet, decision, 'Van', {
      now: () => new Date('2026-07-29T13:00:00.000Z')
    });

    assert.deepEqual(result, {
      timestamp: '2026-07-29T13:00:00.000Z',
      packetId: packet.id,
      integritySha256: packet.integritySha256,
      idempotencyKey: packet.idempotencyKey,
      decision,
      decidedBy: 'Van'
    });
    const audits = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(audits.map((entry) => entry.event), [
      'approval_decision_attempted',
      'approval_decision_recorded'
    ]);
    assert.equal(audits[1].finalText, packet.finalText);
    assert.equal(verifyAuditLedger(paths.auditPath).ok, true);
  }
});

test('altered and expired packets cannot record a decision', () => {
  const alteredPaths = tempPaths();
  const altered = { ...makePacket(), finalText: 'Altered.' };
  assert.throws(() => recordApprovalDecision(alteredPaths, altered, 'APPROVED', 'Van', {
    now: () => new Date('2026-07-29T13:00:00.000Z')
  }), { code: 'BLOCKED_INTEGRITY_MISMATCH' });
  assert.equal(fs.existsSync(alteredPaths.approvalsPath), false);

  const expiredPaths = tempPaths();
  const expiredPacket = makePacket();
  assert.throws(() => recordApprovalDecision(expiredPaths, expiredPacket, 'APPROVED', 'Van', {
    now: () => new Date(Date.parse(expiredPacket.expiresAt) + 1)
  }), { code: 'BLOCKED_EXPIRED' });
  assert.equal(fs.existsSync(expiredPaths.approvalsPath), false);
});

test('structurally malformed packet cannot record a local approval', () => {
  const paths = tempPaths();
  const packet = makePacket({ action: {}, recipient: {}, finalText: '' });
  assert.throws(() => recordApprovalDecision(paths, packet, 'APPROVED', 'Van'), {
    code: 'BLOCKED_INVALID_PACKET'
  });
  assert.equal(fs.existsSync(paths.approvalsPath), false);
  assert.equal(fs.existsSync(paths.auditPath), false);
});

test('RED packets remain non-promotable even with valid integrity', () => {
  const paths = tempPaths();
  const redPacket = makePacket({ tier: 'RED', status: 'RED' });
  assert.throws(() => recordApprovalDecision(paths, redPacket, 'APPROVED', 'Van'), {
    code: 'BLOCKED_NOT_APPROVABLE'
  });
  assert.equal(fs.existsSync(paths.approvalsPath), false);
});

test('approval write failure records approval_decision_failed', () => {
  const paths = tempPaths();
  assert.throws(() => recordApprovalDecision(paths, makePacket(), 'APPROVED', 'Van', {
    now: () => new Date('2026-07-29T13:00:00.000Z'),
    appendApproval: () => { throw new Error('approval write failed'); }
  }), { code: 'FAILED_APPROVAL_WRITE' });
  const events = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((entry) => entry.event), [
    'approval_decision_attempted',
    'approval_decision_failed'
  ]);
});

test('attempt audit failure prevents approval append', () => {
  const paths = tempPaths();
  assert.throws(() => recordApprovalDecision(paths, makePacket(), 'APPROVED', 'Van', {
    appendAudit: () => { throw Object.assign(new Error('audit failed'), { code: 'FAILED_AUDIT_WRITE' }); }
  }), { code: 'FAILED_AUDIT_WRITE' });
  assert.equal(fs.existsSync(paths.approvalsPath), false);
});

test('malformed or invalid existing approval ledger blocks before any mutation', () => {
  const validEntry = {
    timestamp: '2026-07-29T12:00:00.000Z',
    packetId: 'c'.repeat(16),
    integritySha256: 'd'.repeat(64),
    idempotencyKey: 'e'.repeat(24),
    decision: 'APPROVED',
    decidedBy: 'Van'
  };
  const invalidLedgers = [
    '{not-json\n',
    'null\n',
    `${JSON.stringify({ ...validEntry, idempotencyKey: undefined })}\n`
  ];

  for (const initial of invalidLedgers) {
    const paths = tempPaths();
    fs.writeFileSync(paths.approvalsPath, initial, 'utf8');
    assert.throws(() => recordApprovalDecision(
      paths, makePacket(), 'APPROVED', 'Van'
    ), { code: 'FAILED_APPROVAL_LEDGER_READ' });
    assert.equal(fs.readFileSync(paths.approvalsPath, 'utf8'), initial);
    assert.equal(fs.existsSync(paths.auditPath), false);
  }
});

test('final audit failure after approval append is unresolved', () => {
  const paths = tempPaths();
  let auditCalls = 0;
  assert.throws(() => recordApprovalDecision(paths, makePacket(), 'APPROVED', 'Van', {
    now: () => new Date('2026-07-29T13:00:00.000Z'),
    appendAudit: (auditPath, record, options) => {
      auditCalls += 1;
      if (auditCalls === 2) throw Object.assign(new Error('audit failed'), { code: 'FAILED_AUDIT_WRITE' });
      return appendAuditRecord(auditPath, record, options);
    }
  }), { code: 'UNRESOLVED_APPROVAL_AUDIT' });
  assert.equal(fs.readFileSync(paths.approvalsPath, 'utf8').trim().split('\n').length, 1);
});

function runApprovalCli(outboxEntries, packetId, decision = 'APPROVED', { readyPacket } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-approve-cli-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'path-outbox.jsonl'),
    outboxEntries.map(JSON.stringify).join('\n') + (outboxEntries.length ? '\n' : ''), 'utf8');
  if (readyPacket) {
    const runId = 'run-approval-test-001';
    const lifecycleOptions = {
      now: () => new Date(readyPacket.createdAt),
      idFactory: () => 'approval-test-temp'
    };
    createRun({ rootDir: dir, runId }, lifecycleOptions);
    for (const status of [
      'VALIDATED', 'EVIDENCE_SELECTED', 'DRAFTED', 'CLAIMS_VERIFIED', 'PACKET_QUEUED'
    ]) {
      transitionRun({ rootDir: dir, runId, to: status }, lifecycleOptions);
    }
    finishRun({ rootDir: dir, runId, status: 'HUMAN_REVIEW' }, lifecycleOptions);
    appendAuditRecord(path.join(dir, 'data', 'path-audit.jsonl'), {
      event: 'approval_packet_queued',
      runId,
      packetId: readyPacket.id,
      integritySha256: readyPacket.integritySha256,
      idempotencyKey: readyPacket.idempotencyKey,
      action: readyPacket.action,
      recipient: readyPacket.recipient,
      finalText: readyPacket.finalText,
      evidenceIds: readyPacket.evidenceIds,
      evidenceHashes: readyPacket.evidenceHashes,
      claimReportHash: readyPacket.claimReportHash,
      tier: readyPacket.tier,
      policyVersion: readyPacket.policyVersion,
      voiceProfile: readyPacket.voiceProfile,
      disclosurePolicy: readyPacket.disclosurePolicy,
      disclosureIncluded: readyPacket.disclosureIncluded,
      provider: readyPacket.provider,
      model: readyPacket.model,
      promptVersion: readyPacket.promptVersion,
      decision: 'LOCAL_REVIEW_READY'
    }, { now: () => new Date(readyPacket.createdAt) });
  }
  return spawnSync(process.execPath, [scriptPath, packetId, decision], {
    cwd: dir,
    encoding: 'utf8'
  });
}

test('approval CLI blocks missing and duplicate packet IDs', () => {
  const packet = makePacket();
  const missing = runApprovalCli([], packet.id);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).status, 'BLOCKED_PACKET_NOT_FOUND');

  const duplicate = runApprovalCli([packet, packet], packet.id);
  assert.equal(duplicate.status, 1);
  assert.equal(JSON.parse(duplicate.stdout).status, 'BLOCKED_DUPLICATE_PACKET_ID');
});

test('approval CLI blocks syntactically valid non-packet outbox entries', () => {
  const result = runApprovalCli([null], 'missing');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_MALFORMED_OUTBOX');
});

test('approval CLI blocks altered and expired outbox packets', () => {
  const packet = makePacket();
  const altered = runApprovalCli([{ ...packet, finalText: 'Altered.' }], packet.id);
  assert.equal(altered.status, 1);
  assert.equal(JSON.parse(altered.stdout).status, 'BLOCKED_INTEGRITY_MISMATCH');

  const expired = runApprovalCli([packet], packet.id, 'APPROVED', { readyPacket: packet });
  assert.equal(expired.status, 0, expired.stderr);
  const actuallyExpired = makePacket({
    createdAt: '2026-07-27T12:00:00.000Z',
    expiresAt: '2026-07-28T12:00:00.000Z'
  });
  const blocked = runApprovalCli([actuallyExpired], actuallyExpired.id);
  assert.equal(blocked.status, 1);
  assert.equal(JSON.parse(blocked.stdout).status, 'BLOCKED_EXPIRED');
});

test('approval CLI blocks a self-consistently hashed malformed packet', () => {
  const packet = makePacket({ action: {}, recipient: {}, finalText: '' });
  const result = runApprovalCli([packet], packet.id);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_INVALID_PACKET');
});
