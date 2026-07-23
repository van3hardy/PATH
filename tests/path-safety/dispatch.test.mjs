import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = path.resolve('scripts/path-dispatch.mjs');

test('approved packet is ready in dry-run without dispatching it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  const approvalsPath = path.join(dir, 'approvals.jsonl');
  const packet = {
    id: 'packet-123',
    status: 'AWAITING_VAN_APPROVAL',
    tier: 'YELLOW',
    action: { type: 'send_email', channel: 'gmail' },
    recipient: { address: 'hm@example.com' }
  };
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  fs.writeFileSync(approvalsPath, `${JSON.stringify({
    packetId: 'packet-123',
    decision: 'APPROVED',
    decidedBy: 'Van'
  })}\n`, 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, packetPath, approvalsPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'READY_TO_DISPATCH',
    packetId: 'packet-123',
    tier: 'YELLOW'
  });
  assert.equal(fs.readdirSync(dir).sort().join(','), 'approvals.jsonl,packet.json');
});

test('dispatch blocks a rejected packet in dry-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  const approvalsPath = path.join(dir, 'approvals.jsonl');
  fs.writeFileSync(packetPath, JSON.stringify({ id: 'packet-123', tier: 'YELLOW' }), 'utf8');
  fs.writeFileSync(approvalsPath, `${JSON.stringify({
    packetId: 'packet-123',
    decision: 'REJECTED',
    decidedBy: 'Van'
  })}\n`, 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, packetPath, approvalsPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'BLOCKED_REJECTED',
    packetId: 'packet-123',
    tier: 'YELLOW'
  });
});

test('dispatch blocks a packet without a matching approval in dry-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  const approvalsPath = path.join(dir, 'approvals.jsonl');
  fs.writeFileSync(packetPath, JSON.stringify({ id: 'packet-123', tier: 'YELLOW' }), 'utf8');
  fs.writeFileSync(approvalsPath, `${JSON.stringify({
    packetId: 'other-packet',
    decision: 'APPROVED',
    decidedBy: 'Van'
  })}\n`, 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, packetPath, approvalsPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'BLOCKED_NOT_APPROVED',
    packetId: 'packet-123',
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
