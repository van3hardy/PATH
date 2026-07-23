import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = path.resolve('scripts/path-dispatch.mjs');

function makePacket(overrides = {}) {
  const packet = {
    createdAt: '2026-07-23T20:00:00.000Z',
    status: 'AWAITING_VAN_APPROVAL',
    tier: 'YELLOW',
    action: { type: 'send_email', channel: 'gmail' },
    recipient: { address: 'hm@example.com' },
    finalText: 'Van builds agent workflows on Windows 11 with PowerShell.',
    ...overrides
  };
  packet.id = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      action: packet.action,
      recipient: packet.recipient,
      text: packet.finalText,
      createdAt: packet.createdAt
    }))
    .digest('hex')
    .slice(0, 16);
  return packet;
}

function writeApproval(dir, packetId, decision = 'APPROVED') {
  const approvalsPath = path.join(dir, 'approvals.jsonl');
  fs.writeFileSync(approvalsPath, `${JSON.stringify({
    packetId,
    decision,
    decidedBy: 'Van'
  })}\n`, 'utf8');
  return approvalsPath;
}

function writeDispatchLedger(dir, entries = []) {
  const dispatchPath = path.join(dir, 'dispatch.jsonl');
  fs.writeFileSync(dispatchPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
  return dispatchPath;
}

test('approved packet is ready in dry-run without dispatching it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  const packet = makePacket();
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  const approvalsPath = writeApproval(dir, packet.id);
  const dispatchPath = writeDispatchLedger(dir);

  const result = spawnSync(process.execPath, [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'READY_TO_DISPATCH',
    packetId: packet.id,
    tier: 'YELLOW'
  });
  assert.equal(fs.readdirSync(dir).sort().join(','), 'approvals.jsonl,dispatch.jsonl,packet.json');
});

test('dispatch blocks a rejected packet in dry-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  const packet = makePacket();
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  const approvalsPath = writeApproval(dir, packet.id, 'REJECTED');
  const dispatchPath = writeDispatchLedger(dir);

  const result = spawnSync(process.execPath, [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'BLOCKED_REJECTED',
    packetId: packet.id,
    tier: 'YELLOW'
  });
});

test('dispatch blocks a packet without a matching approval in dry-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  const packet = makePacket();
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  const approvalsPath = writeApproval(dir, 'other-packet');
  const dispatchPath = writeDispatchLedger(dir);

  const result = spawnSync(process.execPath, [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'BLOCKED_NOT_APPROVED',
    packetId: packet.id,
    tier: 'YELLOW'
  });
});

test('dispatch blocks a packet already recorded as dispatched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  const packet = makePacket();
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  const approvalsPath = writeApproval(dir, packet.id);
  const dispatchPath = writeDispatchLedger(dir, [{ packetId: packet.id, event: 'dispatch_completed' }]);

  const result = spawnSync(process.execPath, [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'BLOCKED_ALREADY_DISPATCHED',
    packetId: packet.id,
    tier: 'YELLOW'
  });
});

test('dispatch blocks a packet with a non-dispatchable status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  const packet = makePacket({ status: 'GREEN' });
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  const approvalsPath = writeApproval(dir, packet.id);
  const dispatchPath = writeDispatchLedger(dir);

  const result = spawnSync(process.execPath, [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'BLOCKED_NOT_DISPATCHABLE',
    packetId: packet.id,
    tier: 'YELLOW'
  });
});

test('dispatch blocks malformed packet input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  fs.writeFileSync(packetPath, '{not-json', 'utf8');
  const approvalsPath = writeApproval(dir, 'packet-123');
  const dispatchPath = writeDispatchLedger(dir);

  const result = spawnSync(process.execPath, [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'BLOCKED_INVALID_PACKET',
    packetId: null,
    tier: null
  });
});

test('dispatch blocks a packet whose content no longer matches its id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  const packet = makePacket();
  packet.finalText = 'Tampered text.';
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  const approvalsPath = writeApproval(dir, packet.id);
  const dispatchPath = writeDispatchLedger(dir);

  const result = spawnSync(process.execPath, [scriptPath, packetPath, approvalsPath, dispatchPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'BLOCKED_INTEGRITY_MISMATCH',
    packetId: packet.id,
    tier: 'YELLOW'
  });
});

test('dispatch refuses to run without the dry-run flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  fs.writeFileSync(packetPath, JSON.stringify({ id: 'packet-123' }), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, packetPath], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dry-run/);
  assert.equal(fs.readdirSync(dir).sort().join(','), 'packet.json');
});
