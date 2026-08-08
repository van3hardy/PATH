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