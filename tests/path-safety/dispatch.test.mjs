import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildPacketIntegrityFields } from '../../path-safety/packet-integrity.mjs';
import { evaluateDryRun } from '../../scripts/path-dispatch.mjs';

const scriptPath = path.resolve('scripts/path-dispatch.mjs');

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
    finalText: 'Van builds agent workflows on Windows 11 with PowerShell.',
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

test('evaluateDryRun verifies exact approval binding without dispatching', () => {
  const packet = makePacket();
  assert.deepEqual(evaluateDryRun({
    packet,
    approvals: [approvalFor(packet)],
    dispatches: [],
    now: new Date()
  }), { status: 'READY_TO_DISPATCH' });

  assert.deepEqual(evaluateDryRun({
    packet,
    approvals: [{ ...approvalFor(packet), integritySha256: 'f'.repeat(64) }],
    dispatches: [],
    now: new Date()
  }), { status: 'BLOCKED_NOT_APPROVED' });
});

test('evaluateDryRun rejects exact-bound approval not decided by Van', () => {
  const packet = makePacket();
  assert.deepEqual(evaluateDryRun({
    packet,
    approvals: [{ ...approvalFor(packet), decidedBy: 'Mallory' }],
    dispatches: [],
    now: new Date()
  }), { status: 'BLOCKED_NOT_APPROVED' });
});

test('evaluateDryRun emits shared integrity and expiry failure codes', () => {
  const packet = makePacket();
  assert.deepEqual(evaluateDryRun({
    packet: { ...packet, finalText: 'Tampered text.' },
    approvals: [approvalFor(packet)],
    dispatches: [],
    now: new Date()
  }), { status: 'BLOCKED_INTEGRITY_MISMATCH' });

  const expired = makePacket({
    createdAt: '2026-07-27T12:00:00.000Z',
    expiresAt: '2026-07-28T12:00:00.000Z'
  });
  assert.deepEqual(evaluateDryRun({
    packet: expired,
    approvals: [approvalFor(expired)],
    dispatches: [],
    now: new Date('2026-07-29T12:00:00.000Z')
  }), { status: 'BLOCKED_EXPIRED' });
});

function writeApproval(dir, packet, decision = 'APPROVED') {
  const approvalsPath = path.join(dir, 'approvals.jsonl');
  fs.writeFileSync(approvalsPath, `${JSON.stringify(approvalFor(packet, decision))}\n`, 'utf8');
  return approvalsPath;
}

function writeDispatchLedger(dir, entries = []) {
  const dispatchPath = path.join(dir, 'dispatch.jsonl');
  fs.writeFileSync(dispatchPath, entries.map(JSON.stringify).join('\n') + (entries.length ? '\n' : ''), 'utf8');
  return dispatchPath;
}

function runCli(packet, { decision = 'APPROVED', dispatches = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  const approvalsPath = writeApproval(dir, packet, decision);
  const dispatchPath = writeDispatchLedger(dir, dispatches);
  const result = spawnSync(process.execPath,
    [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'],
    { encoding: 'utf8' });
  return { dir, result };
}

test('approved packet is ready in dry-run without writing dispatch state', () => {
  const packet = makePacket();
  const { dir, result } = runCli(packet);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run', status: 'READY_TO_DISPATCH', packetId: packet.id, tier: 'YELLOW'
  });
  assert.equal(fs.readdirSync(dir).sort().join(','), 'approvals.jsonl,dispatch.jsonl,packet.json');
});

test('dry-run blocks rejected, unapproved, and already dispatched packets', () => {
  const rejectedPacket = makePacket();
  assert.equal(JSON.parse(runCli(rejectedPacket, { decision: 'REJECTED' }).result.stdout).status,
    'BLOCKED_REJECTED');

  const unapprovedPacket = makePacket();
  const unapproved = runCli(unapprovedPacket);
  fs.writeFileSync(path.join(unapproved.dir, 'approvals.jsonl'), `${JSON.stringify({
    ...approvalFor(unapprovedPacket), packetId: 'other-packet'
  })}\n`, 'utf8');
  const retry = spawnSync(process.execPath, [
    scriptPath,
    path.join(unapproved.dir, 'packet.json'),
    path.join(unapproved.dir, 'approvals.jsonl'),
    path.join(unapproved.dir, 'dispatch.jsonl'),
    '--dry-run'
  ], { encoding: 'utf8' });
  assert.equal(JSON.parse(retry.stdout).status, 'BLOCKED_NOT_APPROVED');

  const dispatchedPacket = makePacket();
  assert.equal(JSON.parse(runCli(dispatchedPacket, {
    dispatches: [{ packetId: dispatchedPacket.id, event: 'dispatch_completed' }]
  }).result.stdout).status, 'BLOCKED_ALREADY_DISPATCHED');
});

test('dry-run blocks non-dispatchable and tampered packets', () => {
  const nonDispatchable = makePacket({ status: 'GREEN' });
  assert.equal(JSON.parse(runCli(nonDispatchable).result.stdout).status, 'BLOCKED_NOT_DISPATCHABLE');

  const packet = makePacket();
  const tampered = { ...packet, finalText: 'Tampered text.' };
  const { result } = runCli(tampered);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_INTEGRITY_MISMATCH');
});

test('dispatch blocks malformed packet input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  fs.writeFileSync(packetPath, '{not-json', 'utf8');
  const approvalsPath = path.join(dir, 'approvals.jsonl');
  const dispatchPath = path.join(dir, 'dispatch.jsonl');
  fs.writeFileSync(approvalsPath, '', 'utf8');
  fs.writeFileSync(dispatchPath, '', 'utf8');
  const result = spawnSync(process.execPath,
    [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run', status: 'BLOCKED_INVALID_PACKET', packetId: null, tier: null
  });
});

test('dispatch CLI blocks non-object approval and dispatch JSONL entries', () => {
  const packet = makePacket();
  const { dir } = runCli(packet);
  const packetPath = path.join(dir, 'packet.json');
  const approvalsPath = path.join(dir, 'approvals.jsonl');
  const dispatchPath = path.join(dir, 'dispatch.jsonl');

  fs.writeFileSync(approvalsPath, 'null\n', 'utf8');
  let result = spawnSync(process.execPath,
    [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'],
    { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"status": "BLOCKED_INVALID_APPROVALS"/);

  fs.writeFileSync(approvalsPath, `${JSON.stringify(approvalFor(packet))}\n`, 'utf8');
  fs.writeFileSync(dispatchPath, 'null\n', 'utf8');
  result = spawnSync(process.execPath,
    [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'],
    { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"status": "BLOCKED_INVALID_DISPATCHES"/);
});

test('dispatch refuses to run without the dry-run flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  fs.writeFileSync(packetPath, JSON.stringify({ id: 'packet-123' }), 'utf8');
  const result = spawnSync(process.execPath, [scriptPath, packetPath], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dry-run/);
  assert.equal(fs.readdirSync(dir).sort().join(','), 'packet.json');
});
