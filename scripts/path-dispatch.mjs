#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyAuditLedger } from '../path-safety/audit-ledger.mjs';
import { verifyPacketIntegrity } from '../path-safety/packet-integrity.mjs';

export function evaluateDryRun({ packet, approvals, dispatches, auditPath, now = new Date() }) {
  if (!packet || typeof packet !== 'object' ||
      !packet.id || !packet.createdAt || !packet.action || !packet.recipient ||
      typeof packet.finalText !== 'string') {
    return { status: 'BLOCKED_INVALID_PACKET' };
  }

  const integrity = verifyPacketIntegrity(packet, { now });
  if (!integrity.ok) return { status: integrity.code };

  if (packet.status !== 'AWAITING_VAN_APPROVAL' || packet.tier !== 'YELLOW') {
    return { status: 'BLOCKED_NOT_DISPATCHABLE' };
  }

  if (dispatches.some((entry) =>
    entry.packetId === packet.id && entry.event === 'dispatch_completed')) {
    return { status: 'BLOCKED_ALREADY_DISPATCHED' };
  }

  const exactApprovals = approvals.filter((entry) =>
    entry.packetId === packet.id &&
    entry.integritySha256 === packet.integritySha256 &&
    entry.idempotencyKey === packet.idempotencyKey &&
    entry.decidedBy === 'Van');
  const latestApproval = exactApprovals.at(-1);
  if (latestApproval?.decision === 'APPROVED') return gateOnAuditLedger(packet, auditPath);
  if (latestApproval?.decision === 'REJECTED') return { status: 'BLOCKED_REJECTED' };
  return { status: 'BLOCKED_NOT_APPROVED' };
}

// The audit ledger is the authority: entries are read only after the existing
// verifyAuditLedger passes over the whole file, so no weaker parallel check exists.
function gateOnAuditLedger(packet, auditPath) {
  if (typeof auditPath !== 'string' || !fs.existsSync(auditPath)) {
    return { status: 'BLOCKED_AUDIT_UNVERIFIED' };
  }
  // verifyAuditLedger reads the file without guarding, so an unreadable path
  // (directory, permission error, race with removal) must not escape as a throw.
  let entries;
  try {
    if (!verifyAuditLedger(auditPath).ok) return { status: 'BLOCKED_AUDIT_UNVERIFIED' };
    entries = parseJsonl(auditPath);
  } catch {
    return { status: 'BLOCKED_AUDIT_UNVERIFIED' };
  }

  // Match on identity alone, never on decision, so an APPROVED event paired with
  // a contradictory REJECTED event is caught as ambiguous rather than accepted.
  const matches = entries.filter((entry) =>
    entry.event === 'approval_decision_recorded' &&
    entry.packetId === packet.id &&
    entry.integritySha256 === packet.integritySha256 &&
    entry.idempotencyKey === packet.idempotencyKey);

  if (matches.length === 0) return { status: 'BLOCKED_APPROVAL_NOT_IN_AUDIT' };
  if (matches.length > 1) return { status: 'BLOCKED_AMBIGUOUS_AUDIT_APPROVAL' };
  if (matches[0].decision !== 'APPROVED') return { status: 'BLOCKED_AUDIT_NOT_APPROVED' };
  return { status: 'READY_TO_DISPATCH' };
}

function parseJsonl(filePath) {
  const entries = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!entries.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
    throw new Error('non-object JSONL entry');
  }
  return entries;
}

function printResult(status, packet = {}) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    status,
    packetId: packet?.id ?? null,
    tier: packet?.tier ?? null
  }, null, 2));
  return status === 'READY_TO_DISPATCH' ? 0 : 1;
}

function main(args) {
  const [packetPath, approvalsPath, dispatchPath, auditPath, ...flags] = args;
  if (!packetPath || !approvalsPath || !dispatchPath || !auditPath ||
      flags.length !== 1 || flags[0] !== '--dry-run') {
    console.error('Usage: node scripts/path-dispatch.mjs <packet.json> <approvals.jsonl> <dispatch.jsonl> <audit.jsonl> --dry-run');
    return 2;
  }

  let packet;
  try {
    packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  } catch {
    return printResult('BLOCKED_INVALID_PACKET');
  }

  let approvals;
  try {
    approvals = parseJsonl(approvalsPath);
  } catch {
    return printResult('BLOCKED_INVALID_APPROVALS', packet);
  }

  let dispatches;
  try {
    dispatches = parseJsonl(dispatchPath);
  } catch {
    return printResult('BLOCKED_INVALID_DISPATCHES', packet);
  }

  return printResult(evaluateDryRun({ packet, approvals, dispatches, auditPath }).status, packet);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
