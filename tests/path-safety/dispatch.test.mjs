import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = path.resolve('scripts/path-dispatch.mjs');

test('dispatch dry-run reports the packet without dispatching it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-dispatch-'));
  const packetPath = path.join(dir, 'packet.json');
  const packet = {
    id: 'packet-123',
    status: 'AWAITING_VAN_APPROVAL',
    tier: 'YELLOW',
    action: { type: 'send_email', channel: 'gmail' },
    recipient: { address: 'hm@example.com' }
  };
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, packetPath, '--dry-run'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'dry-run',
    status: 'NOT_DISPATCHED',
    packetId: 'packet-123',
    tier: 'YELLOW'
  });
  assert.equal(fs.readdirSync(dir).sort().join(','), 'packet.json');
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
