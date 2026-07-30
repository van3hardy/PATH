#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyPacketIntegrity } from '../path-safety/packet-integrity.mjs';

export function evaluateDryRun({ packet, approvals, dispatches, now = new Date() }) {
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
  if (latestApproval?.decision === 'APPROVED') return { status: 'READY_TO_DISPATCH' };
  if (latestApproval?.decision === 'REJECTED') return { status: 'BLOCKED_REJECTED' };
  return { status: 'BLOCKED_NOT_APPROVED' };
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
  const [packetPath, approvalsPath, dispatchPath, ...flags] = args;
  if (!packetPath || !approvalsPath || !dispatchPath ||
      flags.length !== 1 || flags[0] !== '--dry-run') {
    console.error('Usage: node scripts/path-dispatch.mjs <packet.json> <approvals.jsonl> <dispatch.jsonl> --dry-run');
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

  return printResult(evaluateDryRun({ packet, approvals, dispatches }).status, packet);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
