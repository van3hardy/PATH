import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex, stableStringify, verifyPacketIntegrity } from './packet-integrity.mjs';
import { REAL_PROVIDER_IDS } from '../path-brain/provider-ids.mjs';

const REQUIRED_FIELDS = [
  'schemaVersion', 'timestamp', 'event', 'runId', 'packetId', 'integritySha256',
  'idempotencyKey', 'action', 'recipient', 'finalText', 'finalTextSha256',
  'evidenceIds', 'evidenceHashes', 'claimReportHash', 'tier', 'policyVersion',
  'voiceProfile', 'disclosurePolicy', 'disclosureIncluded', 'provider', 'model',
  'promptVersion', 'decision', 'previousHash', 'recordHash'
];
const CALLER_FIELDS = REQUIRED_FIELDS.filter((field) => ![
  'schemaVersion', 'timestamp', 'finalTextSha256', 'previousHash', 'recordHash'
].includes(field));
const HEX_16 = /^[a-f0-9]{16}$/;
const HEX_24 = /^[a-f0-9]{24}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const LOCKED_POLICY = 'path-safety-v1';
const LOCKED_VOICE = 'path-recruiter-persistent-respectful-v1';
const LOCKED_DISCLOSURE = 'always-disclose-ai-assistance-v1';
const FIRST_TOUCH_PROMPT = 'path-recruiter-v1';
const REPLY_PROMPT = 'path-reply-v1';
const LOCKED_PROVIDER = 'fake';
const FIRST_TOUCH_MODEL = 'deterministic-recruiter-template-v1';
const REPLY_MODEL = 'deterministic-reply-template-v1';
const EVENT_RULES = new Map([
  ['approval_packet_queue_attempted', { decisions: ['QUEUE_FOR_APPROVAL'], tier: 'YELLOW' }],
  ['approval_packet_queued', { decisions: ['LOCAL_REVIEW_READY'], tier: 'YELLOW' }],
  ['approval_packet_queue_failed', { decisions: ['FAILED_OUTBOX_WRITE'], tier: 'YELLOW' }],
  ['duplicate_proposal_blocked', { decisions: ['BLOCK_DUPLICATE_PROPOSAL'], tier: 'YELLOW' }],
  ['red_action_blocked', { decisions: ['BLOCK_RED'], tier: 'RED' }],
  ['green_action_allowed', { decisions: ['ALLOW_GREEN'], tier: 'GREEN' }],
  ['approval_decision_attempted', { decisions: ['APPROVED', 'REJECTED'], tier: 'YELLOW' }],
  ['approval_decision_recorded', { decisions: ['APPROVED', 'REJECTED'], tier: 'YELLOW' }],
  ['approval_decision_failed', { decisions: ['FAILED_APPROVAL_WRITE'], tier: 'YELLOW' }],
  ['unsupported_claims_blocked', {
    decisions: ['BLOCKED_UNSUPPORTED_CLAIMS'], tier: null, diagnostic: true
  }]
]);

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return { entries: [] };
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      entries.push(JSON.parse(lines[index]));
    } catch {
      return { error: { ok: false, code: 'FAILED_AUDIT_MALFORMED', recordIndex: index } };
    }
  }
  return { entries };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasValidAction(action, tier, diagnostic = false) {
  if (!isPlainObject(action) || !isNonemptyString(action.type) ||
      !isNonemptyString(action.channel)) return false;
  if (tier === 'YELLOW' || diagnostic) {
    return isNonemptyString(action.touch) && isPlainObject(action.opportunity) &&
      isNonemptyString(action.opportunity.company) &&
      isNonemptyString(action.opportunity.role);
  }
  if (Object.hasOwn(action, 'opportunity')) {
    return isPlainObject(action.opportunity) &&
      isNonemptyString(action.opportunity.company) &&
      isNonemptyString(action.opportunity.role);
  }
  return true;
}

function hasValidRecipient(recipient) {
  return isPlainObject(recipient) && isNonemptyString(recipient.name) &&
    isNonemptyString(recipient.address) &&
    (!Object.hasOwn(recipient, 'channel') || isNonemptyString(recipient.channel));
}

function hasValidAuditFacts(entry) {
  const rule = EVENT_RULES.get(entry.event);
  if (!rule || !rule.decisions.includes(entry.decision) || entry.tier !== rule.tier) return false;
  const diagnostic = rule.diagnostic === true;
  if (diagnostic) {
    if (entry.packetId !== null || entry.integritySha256 !== null ||
        entry.idempotencyKey !== null) return false;
  } else if (!HEX_16.test(entry.packetId) || !HEX_64.test(entry.integritySha256) ||
      !HEX_24.test(entry.idempotencyKey)) return false;

  if (!hasValidAction(entry.action, entry.tier, diagnostic) ||
      !hasValidRecipient(entry.recipient) ||
      !isNonemptyString(entry.finalText) ||
      !Array.isArray(entry.evidenceIds) || !Array.isArray(entry.evidenceHashes) ||
      entry.evidenceIds.length === 0 ||
      entry.evidenceIds.length !== entry.evidenceHashes.length ||
      !entry.evidenceIds.every(isNonemptyString) ||
      !entry.evidenceHashes.every((hash) => HEX_64.test(hash)) ||
      !HEX_64.test(entry.claimReportHash) ||
      entry.policyVersion !== LOCKED_POLICY || entry.voiceProfile !== LOCKED_VOICE ||
      entry.disclosurePolicy !== LOCKED_DISCLOSURE || entry.disclosureIncluded !== true ||
      ![FIRST_TOUCH_PROMPT, REPLY_PROMPT].includes(entry.promptVersion) ||
      !(entry.runId === null || isNonemptyString(entry.runId))) return false;

  if (entry.provider === LOCKED_PROVIDER &&
      ((entry.promptVersion === FIRST_TOUCH_PROMPT && entry.model === FIRST_TOUCH_MODEL) ||
       (entry.promptVersion === REPLY_PROMPT && entry.model === REPLY_MODEL))) {
    return true;
  }
  if (REAL_PROVIDER_IDS.includes(entry.provider) && isNonemptyString(entry.model)) return true;
  return diagnostic && entry.provider === 'none' && entry.model === 'none';
}

function hasValidSchema(entry) {
  if (!isPlainObject(entry) ||
      REQUIRED_FIELDS.some((field) => !Object.hasOwn(entry, field))) return false;
  if (entry.schemaVersion !== 'path.audit.v1' ||
      typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp)) ||
      !HEX_64.test(entry.finalTextSha256) ||
      !/^(GENESIS|[a-f0-9]{64})$/.test(entry.previousHash) ||
      !HEX_64.test(entry.recordHash) ||
      entry.finalTextSha256 !== sha256Hex(entry.finalText)) return false;
  return hasValidAuditFacts(entry);
}

export function verifyAuditLedger(auditPath, { expectedLastRecordHash } = {}) {
  const loaded = readJsonl(auditPath);
  if (loaded.error) return loaded.error;

  let previousHash = 'GENESIS';
  const recordHashes = new Set();
  for (let index = 0; index < loaded.entries.length; index += 1) {
    const entry = loaded.entries[index];
    if (!isPlainObject(entry) || !Object.hasOwn(entry, 'previousHash') ||
        !Object.hasOwn(entry, 'recordHash')) {
      return { ok: false, code: 'FAILED_AUDIT_SCHEMA', recordIndex: index };
    }
    if (entry.previousHash !== previousHash) {
      return { ok: false, code: 'FAILED_AUDIT_CHAIN', recordIndex: index };
    }
    const { recordHash, ...withoutRecordHash } = entry;
    if (recordHash !== sha256Hex(stableStringify(withoutRecordHash))) {
      return { ok: false, code: 'FAILED_AUDIT_HASH', recordIndex: index };
    }
    if (!hasValidSchema(entry)) {
      return { ok: false, code: 'FAILED_AUDIT_SCHEMA', recordIndex: index };
    }
    recordHashes.add(recordHash);
    previousHash = recordHash;
  }

  const lastRecordHash = loaded.entries.at(-1)?.recordHash ?? null;
  if (expectedLastRecordHash != null && !recordHashes.has(expectedLastRecordHash)) {
    return {
      ok: false,
      code: 'FAILED_AUDIT_TRUNCATED',
      recordCount: loaded.entries.length,
      lastRecordHash
    };
  }
  return {
    ok: true,
    code: 'AUDIT_LEDGER_OK',
    recordCount: loaded.entries.length,
    lastRecordHash
  };
}

function normalizeAuditRecord(record, timestamp, previousHash) {
  const withoutRecordHash = {
    schemaVersion: 'path.audit.v1',
    timestamp,
    event: record.event,
    runId: record.runId,
    packetId: record.packetId,
    integritySha256: record.integritySha256,
    idempotencyKey: record.idempotencyKey,
    action: structuredClone(record.action),
    recipient: structuredClone(record.recipient),
    finalText: record.finalText,
    finalTextSha256: sha256Hex(record.finalText),
    evidenceIds: [...record.evidenceIds],
    evidenceHashes: [...record.evidenceHashes],
    claimReportHash: record.claimReportHash,
    tier: record.tier,
    policyVersion: record.policyVersion,
    voiceProfile: record.voiceProfile,
    disclosurePolicy: record.disclosurePolicy,
    disclosureIncluded: record.disclosureIncluded,
    provider: record.provider,
    model: record.model,
    promptVersion: record.promptVersion,
    decision: record.decision,
    previousHash
  };
  return {
    ...withoutRecordHash,
    recordHash: sha256Hex(stableStringify(withoutRecordHash))
  };
}

export function appendAuditRecord(auditPath, record, { now = () => new Date() } = {}) {
  if (!isPlainObject(record) ||
      CALLER_FIELDS.some((field) => !Object.hasOwn(record, field)) ||
      !hasValidAuditFacts(record)) throw codedError('FAILED_AUDIT_SCHEMA');
  const verification = verifyAuditLedger(auditPath);
  if (!verification.ok) throw codedError(verification.code);
  const entry = normalizeAuditRecord(
    record,
    now().toISOString(),
    verification.lastRecordHash ?? 'GENESIS'
  );
  if (!hasValidSchema(entry)) throw codedError('FAILED_AUDIT_SCHEMA');

  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    throw codedError('FAILED_AUDIT_WRITE', error);
  }
  return entry;
}

function packetAuditRecord(packet, event, decision) {
  return {
    event,
    runId: packet.runId ?? null,
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

function appendApprovalFile(approvalsPath, entry) {
  fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
  fs.appendFileSync(approvalsPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function hasValidApprovalEntry(entry) {
  return isPlainObject(entry) && typeof entry.timestamp === 'string' &&
    Number.isFinite(Date.parse(entry.timestamp)) &&
    HEX_16.test(entry.packetId) && HEX_64.test(entry.integritySha256) &&
    HEX_24.test(entry.idempotencyKey) &&
    ['APPROVED', 'REJECTED'].includes(entry.decision) && entry.decidedBy === 'Van';
}

function verifyApprovalLedger(approvalsPath) {
  if (!fs.existsSync(approvalsPath)) return;
  let entries;
  try {
    entries = fs.readFileSync(approvalsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw codedError('FAILED_APPROVAL_LEDGER_READ', error);
  }
  if (!entries.every(hasValidApprovalEntry)) {
    throw codedError('FAILED_APPROVAL_LEDGER_READ');
  }
}

export function recordApprovalDecision(
  paths,
  packet,
  decision,
  reviewer,
  options = {}
) {
  const now = options.now || (() => new Date());
  const nowValue = now();
  const integrity = verifyPacketIntegrity(packet, { now: nowValue });
  if (!integrity.ok) throw codedError(integrity.code);
  if (packet.tier !== 'YELLOW' || packet.status !== 'AWAITING_VAN_APPROVAL') {
    throw codedError('BLOCKED_NOT_APPROVABLE');
  }
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw codedError('BLOCKED_INVALID_APPROVAL_DECISION');
  }
  if (reviewer !== 'Van') throw codedError('BLOCKED_INVALID_REVIEWER');
  verifyApprovalLedger(paths.approvalsPath);

  const appendAudit = options.appendAudit || appendAuditRecord;
  const appendApproval = options.appendApproval || appendApprovalFile;
  const auditOptions = { now: () => nowValue };
  try {
    appendAudit(paths.auditPath,
      packetAuditRecord(packet, 'approval_decision_attempted', decision),
      auditOptions);
  } catch (error) {
    if (error?.code === 'FAILED_AUDIT_WRITE') throw error;
    throw codedError('FAILED_AUDIT_WRITE', error);
  }

  const entry = {
    timestamp: nowValue.toISOString(),
    packetId: packet.id,
    integritySha256: packet.integritySha256,
    idempotencyKey: packet.idempotencyKey,
    decision,
    decidedBy: reviewer
  };
  try {
    appendApproval(paths.approvalsPath, entry);
  } catch (error) {
    try {
      appendAudit(paths.auditPath,
        packetAuditRecord(packet, 'approval_decision_failed', 'FAILED_APPROVAL_WRITE'),
        auditOptions);
    } catch (auditError) {
      throw codedError('UNRESOLVED_APPROVAL_AUDIT', auditError);
    }
    throw codedError('FAILED_APPROVAL_WRITE', error);
  }

  try {
    appendAudit(paths.auditPath,
      packetAuditRecord(packet, 'approval_decision_recorded', decision),
      auditOptions);
  } catch (error) {
    throw codedError('UNRESOLVED_APPROVAL_AUDIT', error);
  }
  return entry;
}
