#!/usr/bin/env node
import fs from 'node:fs';

const [packetPath, approvalsPath, ...flags] = process.argv.slice(2);

if (!packetPath || !approvalsPath || flags.length !== 1 || flags[0] !== '--dry-run') {
  console.error('Usage: node scripts/path-dispatch.mjs <packet.json> <approvals.jsonl> --dry-run');
  process.exit(2);
}

const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
const approvals = fs.readFileSync(approvalsPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.packetId === packet.id);
const latestApproval = approvals.at(-1);
const approved = latestApproval?.decision === 'APPROVED';
const status = approved
  ? 'READY_TO_DISPATCH'
  : latestApproval?.decision === 'REJECTED'
    ? 'BLOCKED_REJECTED'
    : 'BLOCKED_NOT_APPROVED';

console.log(JSON.stringify({
  mode: 'dry-run',
  status,
  packetId: packet.id,
  tier: packet.tier
}, null, 2));

process.exit(approved ? 0 : 1);
