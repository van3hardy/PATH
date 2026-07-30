#!/usr/bin/env node
import fs from 'node:fs';
import { loadRun } from '../path-runner/lifecycle.mjs';
import {
  recordApprovalDecision,
  verifyAuditLedger
} from '../path-safety/audit-ledger.mjs';
import { verifyPacketIntegrity } from '../path-safety/packet-integrity.mjs';

const [packetId, decision] = process.argv.slice(2);
const allowed = new Set(['APPROVED', 'REJECTED']);

function output(status, entry = null, exitCode = 1) {
  console.log(JSON.stringify({ status, entry }, null, 2));
  process.exit(exitCode);
}

if (!packetId || !allowed.has(decision)) {
  console.error('Usage: node scripts/path-approve.mjs <packetId> APPROVED|REJECTED');
  process.exit(2);
}

let packets;
try {
  packets = fs.readFileSync('data/path-outbox.jsonl', 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!packets.every((packet) => packet && typeof packet === 'object' && !Array.isArray(packet))) {
    throw new Error('non-object JSONL entry');
  }
} catch {
  output('BLOCKED_MALFORMED_OUTBOX');
}

const matches = packets.filter((packet) => packet.id === packetId);
if (matches.length === 0) output('BLOCKED_PACKET_NOT_FOUND');
if (matches.length !== 1) output('BLOCKED_DUPLICATE_PACKET_ID');

const packet = matches[0];
const integrity = verifyPacketIntegrity(packet);
if (!integrity.ok) output(integrity.code);

const auditPath = 'data/path-audit.jsonl';
const auditVerification = verifyAuditLedger(auditPath);
if (!auditVerification.ok) output('BLOCKED_RUN_NOT_REVIEW_READY');

let queuedEvents;
try {
  queuedEvents = fs.readFileSync(auditPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'approval_packet_queued' &&
      entry.packetId === packet.id &&
      entry.integritySha256 === packet.integritySha256 &&
      entry.idempotencyKey === packet.idempotencyKey &&
      entry.decision === 'LOCAL_REVIEW_READY');
} catch {
  output('BLOCKED_RUN_NOT_REVIEW_READY');
}
if (queuedEvents.length !== 1 || typeof queuedEvents[0].runId !== 'string') {
  output('BLOCKED_RUN_NOT_REVIEW_READY');
}

try {
  const run = loadRun({ rootDir: '.', runId: queuedEvents[0].runId });
  if (run.state.status !== 'HUMAN_REVIEW') output('BLOCKED_RUN_NOT_REVIEW_READY');
} catch {
  output('BLOCKED_RUN_NOT_REVIEW_READY');
}

try {
  const entry = recordApprovalDecision({
    approvalsPath: 'data/path-approvals.jsonl',
    auditPath
  }, packet, decision, 'Van');
  output('APPROVAL_DECISION_RECORDED', entry, 0);
} catch (error) {
  output(error?.code || 'FAILED_APPROVAL_DECISION');
}
