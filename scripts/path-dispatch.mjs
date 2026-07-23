#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';

const [packetPath, approvalsPath, dispatchPath, ...flags] = process.argv.slice(2);

if (!packetPath || !approvalsPath || !dispatchPath || flags.length !== 1 || flags[0] !== '--dry-run') {
  console.error('Usage: node scripts/path-dispatch.mjs <packet.json> <approvals.jsonl> <dispatch.jsonl> --dry-run');
  process.exit(2);
}

function output(status, packet = {}) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    status,
    packetId: packet.id ?? null,
    tier: packet.tier ?? null
  }, null, 2));
  process.exit(status === 'READY_TO_DISPATCH' ? 0 : 1);
}

let packet;
try {
  packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
} catch {
  output('BLOCKED_INVALID_PACKET');
}

if (!packet || typeof packet !== 'object') {
  output('BLOCKED_INVALID_PACKET');
}

if (!packet.id || !packet.createdAt || !packet.action || !packet.recipient || typeof packet.finalText !== 'string') {
  output('BLOCKED_INVALID_PACKET', packet);
}

const expectedId = crypto
  .createHash('sha256')
  .update(JSON.stringify({
    action: packet.action,
    recipient: packet.recipient,
    text: packet.finalText,
    createdAt: packet.createdAt
  }))
  .digest('hex')
  .slice(0, 16);

if (packet.id !== expectedId) {
  output('BLOCKED_INTEGRITY_MISMATCH', packet);
}

if (packet.status !== 'AWAITING_VAN_APPROVAL' || packet.tier !== 'YELLOW') {
  output('BLOCKED_NOT_DISPATCHABLE', packet);
}

const approvals = fs.readFileSync(approvalsPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.packetId === packet.id);
const latestApproval = approvals.at(-1);

const dispatches = fs.readFileSync(dispatchPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (dispatches.some((entry) => entry.packetId === packet.id && entry.event === 'dispatch_completed')) {
  output('BLOCKED_ALREADY_DISPATCHED', packet);
}

const approved = latestApproval?.decision === 'APPROVED';
const status = approved
  ? 'READY_TO_DISPATCH'
  : latestApproval?.decision === 'REJECTED'
    ? 'BLOCKED_REJECTED'
    : 'BLOCKED_NOT_APPROVED';

output(status, packet);
