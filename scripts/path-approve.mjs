#!/usr/bin/env node
import { recordApprovalDecision } from '../path-safety/audit-ledger.mjs';

const [packetId, decision] = process.argv.slice(2);
const allowed = new Set(['APPROVED', 'REJECTED']);

if (!packetId || !allowed.has(decision)) {
  console.error('Usage: node scripts/path-approve.mjs <packetId> APPROVED|REJECTED');
  process.exit(2);
}

const entry = recordApprovalDecision({
  approvalsPath: 'data/path-approvals.jsonl',
  auditPath: 'data/path-audit.jsonl'
}, {
  packetId,
  decision,
  decidedBy: 'Van'
});

console.log(JSON.stringify(entry, null, 2));
