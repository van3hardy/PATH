import fs from 'node:fs';
import path from 'node:path';
import { buildApprovalPacket } from './approval-packet.mjs';
import { appendAuditRecord, verifyAuditLedger } from './audit-ledger.mjs';
import { sha256Hex, stableStringify, verifyPacketIntegrity } from './packet-integrity.mjs';

const DEFAULT_PATHS = {
  outboxPath: 'data/path-outbox.jsonl',
  auditPath: 'data/path-audit.jsonl'
};

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function readJsonl(filePath, failureCode) {
  if (!fs.existsSync(filePath)) return [];
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw codedError(failureCode, error);
  }
  try {
    const entries = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    if (!entries.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
      throw new Error('non-object JSONL entry');
    }
    return entries;
  } catch (error) {
    throw codedError(failureCode, error);
  }
}

function auditRecordForPacket(packet, input, event, decision) {
  return {
    event,
    runId: input.runId ?? null,
    packetId: packet.id,
    integritySha256: packet.integritySha256,
    idempotencyKey: packet.idempotencyKey,
    action: packet.action,
    recipient: packet.recipient,
    finalText: packet.finalText,
    evidenceIds: packet.evidenceIds,
    evidenceHashes: packet.evidenceHashes,
    claimReportHash: packet.claimReportHash,
    tier: packet.tier,
    policyVersion: packet.policyVersion,
    voiceProfile: packet.voiceProfile,
    disclosurePolicy: packet.disclosurePolicy,
    disclosureIncluded: packet.disclosureIncluded,
    provider: packet.provider,
    model: packet.model,
    promptVersion: packet.promptVersion,
    decision
  };
}

function unsupportedAuditRecord(input, error) {
  const opportunity = input.opportunity ?? input.action?.opportunity;
  const action = { ...input.action };
  if (opportunity !== undefined) action.opportunity = opportunity;
  return {
    event: 'unsupported_claims_blocked',
    runId: input.runId ?? null,
    packetId: null,
    integritySha256: null,
    idempotencyKey: null,
    action,
    recipient: input.recipient,
    finalText: input.text,
    evidenceIds: [...(input.evidenceIds || [])],
    evidenceHashes: [...(input.evidenceHashes || [])],
    claimReportHash: input.claimReportHash || sha256Hex({
      unsupportedCount: error.unsupportedCount,
      unsupportedHashes: error.unsupportedHashes
    }),
    tier: null,
    policyVersion: 'path-safety-v1',
    voiceProfile: input.voiceProfile,
    disclosurePolicy: input.disclosurePolicy,
    disclosureIncluded: input.disclosureIncluded === true,
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion,
    decision: 'BLOCKED_UNSUPPORTED_CLAIMS'
  };
}

export function gateOutbound(input, paths = DEFAULT_PATHS, options = {}) {
  const appendAudit = options.appendAudit || appendAuditRecord;
  const now = options.now || (() => new Date());
  const auditOptions = { now };
  let packet;
  try {
    packet = buildApprovalPacket(input, { now });
  } catch (error) {
    if (error?.code !== 'BLOCKED_UNSUPPORTED_CLAIMS') throw error;
    appendAudit(paths.auditPath, unsupportedAuditRecord(input, error), auditOptions);
    return { decision: 'BLOCK_UNSUPPORTED_CLAIMS', packet: null };
  }

  const verification = verifyPacketIntegrity(packet, { now: now() });
  if (!verification.ok) throw codedError(verification.code);

  if (packet.tier === 'RED') {
    appendAudit(paths.auditPath,
      auditRecordForPacket(packet, input, 'red_action_blocked', 'BLOCK_RED'),
      auditOptions);
    return { decision: 'BLOCK_RED', packet };
  }

  if (packet.tier === 'YELLOW') {
    const outbox = readJsonl(paths.outboxPath, 'FAILED_OUTBOX_READ');
    if (outbox.some((entry) => entry.idempotencyKey === packet.idempotencyKey)) {
      appendAudit(paths.auditPath,
        auditRecordForPacket(packet, input, 'duplicate_proposal_blocked', 'BLOCK_DUPLICATE_PROPOSAL'),
        auditOptions);
      return { decision: 'BLOCK_DUPLICATE_PROPOSAL', packet: null };
    }

    appendAudit(paths.auditPath,
      auditRecordForPacket(packet, input, 'approval_packet_queue_attempted', 'QUEUE_FOR_APPROVAL'),
      auditOptions);

    try {
      fs.mkdirSync(path.dirname(paths.outboxPath), { recursive: true });
      fs.appendFileSync(paths.outboxPath, `${JSON.stringify(packet)}\n`, 'utf8');
    } catch (error) {
      try {
        appendAudit(paths.auditPath,
          auditRecordForPacket(packet, input, 'approval_packet_queue_failed', 'FAILED_OUTBOX_WRITE'),
          auditOptions);
      } catch (auditError) {
        throw codedError('FAILED_AUDIT_WRITE', auditError);
      }
      throw codedError('FAILED_OUTBOX_WRITE', error);
    }

    try {
      appendAudit(paths.auditPath,
        auditRecordForPacket(packet, input, 'approval_packet_queued', 'LOCAL_REVIEW_READY'),
        auditOptions);
    } catch (error) {
      throw codedError('UNRESOLVED_QUEUE_AUDIT', error);
    }
    return { decision: 'QUEUE_FOR_APPROVAL', packet };
  }

  appendAudit(paths.auditPath,
    auditRecordForPacket(packet, input, 'green_action_allowed', 'ALLOW_GREEN'),
    auditOptions);
  return { decision: 'ALLOW_GREEN', packet };
}

export function reconcileOutboxAudit(outboxPath, auditPath) {
  let outbox;
  let audit;
  try {
    outbox = readJsonl(outboxPath, 'FAILED_OUTBOX_READ');
    audit = readJsonl(auditPath, 'FAILED_AUDIT_MALFORMED');
  } catch (error) {
    return { ok: false, code: 'UNRESOLVED_QUEUE_AUDIT', reason: error.code, packetIds: [] };
  }

  const ledger = verifyAuditLedger(auditPath);
  if (!ledger.ok) {
    return { ok: false, code: 'UNRESOLVED_QUEUE_AUDIT', reason: ledger.code, packetIds: [] };
  }
  const same = (left, right) => stableStringify(left) === stableStringify(right);
  const matchesPacket = (entry, packet) =>
    entry.packetId === packet.id &&
    entry.integritySha256 === packet.integritySha256 &&
    entry.idempotencyKey === packet.idempotencyKey &&
    same(entry.action, packet.action) &&
    same(entry.recipient, packet.recipient) &&
    entry.finalText === packet.finalText &&
    entry.finalTextSha256 === sha256Hex(packet.finalText) &&
    same(entry.evidenceIds, packet.evidenceIds) &&
    same(entry.evidenceHashes, packet.evidenceHashes) &&
    entry.claimReportHash === packet.claimReportHash &&
    entry.tier === packet.tier &&
    entry.policyVersion === packet.policyVersion &&
    entry.voiceProfile === packet.voiceProfile &&
    entry.disclosurePolicy === packet.disclosurePolicy &&
    entry.disclosureIncluded === packet.disclosureIncluded &&
    entry.provider === packet.provider &&
    entry.model === packet.model &&
    entry.promptVersion === packet.promptVersion &&
    entry.decision === 'LOCAL_REVIEW_READY';
  const affectedPacketIds = new Set();
  const validOutbox = [];
  let unresolved = false;
  for (const packet of outbox) {
    const packetVerification = verifyPacketIntegrity(packet, {
      now: new Date(packet.createdAt)
    });
    if (!packetVerification.ok) {
      unresolved = true;
      if (typeof packet.id === 'string') affectedPacketIds.add(packet.id);
      continue;
    }
    validOutbox.push(packet);
  }

  for (const field of ['id', 'integritySha256', 'idempotencyKey']) {
    const groups = new Map();
    for (const packet of validOutbox) {
      const group = groups.get(packet[field]) || [];
      group.push(packet);
      groups.set(packet[field], group);
    }
    for (const group of groups.values()) {
      if (group.length > 1) group.forEach((packet) => affectedPacketIds.add(packet.id));
    }
  }

  const queuedEvents = audit.filter((entry) => entry.event === 'approval_packet_queued');
  for (const packet of validOutbox) {
    const matches = queuedEvents.filter((entry) => matchesPacket(entry, packet));
    if (matches.length !== 1) affectedPacketIds.add(packet.id);
  }
  for (const entry of queuedEvents) {
    const matches = validOutbox.filter((packet) => matchesPacket(entry, packet));
    if (matches.length !== 1) affectedPacketIds.add(entry.packetId);
  }

  const packetIds = [...affectedPacketIds];
  if (unresolved || packetIds.length > 0) {
    return { ok: false, code: 'UNRESOLVED_QUEUE_AUDIT', packetIds };
  }
  return { ok: true, code: 'QUEUE_AUDIT_RECONCILED', packetIds: [] };
}
