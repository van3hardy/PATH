import crypto from 'node:crypto';

const HEX_16 = /^[a-f0-9]{16}$/;
const HEX_24 = /^[a-f0-9]{24}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';
const POLICY_VERSION = 'path-safety-v1';
const PROMPT_VERSION = 'path-recruiter-v1';
const PROVIDER = 'fake';
const MODEL = 'deterministic-recruiter-template-v1';
const PACKET_TTL_MS = 24 * 60 * 60 * 1000;

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(
    typeof value === 'string' ? value : stableStringify(value)
  ).digest('hex');
}

function integrityPayload(packet) {
  return {
    action: packet.action,
    recipient: packet.recipient,
    finalText: packet.finalText,
    evidenceIds: packet.evidenceIds,
    evidenceHashes: packet.evidenceHashes,
    claimReportHash: packet.claimReportHash,
    voiceProfile: packet.voiceProfile,
    disclosurePolicy: packet.disclosurePolicy,
    disclosureIncluded: packet.disclosureIncluded,
    promptVersion: packet.promptVersion,
    provider: packet.provider,
    model: packet.model,
    policyVersion: packet.policyVersion,
    createdAt: packet.createdAt,
    expiresAt: packet.expiresAt
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasValidPacketStructure(packet) {
  if (!isPlainObject(packet) || !isPlainObject(packet.action) || !isPlainObject(packet.recipient)) {
    return false;
  }
  if (!isNonemptyString(packet.action.type) || !isNonemptyString(packet.action.channel) ||
      !isNonemptyString(packet.recipient.name) || !isNonemptyString(packet.recipient.address) ||
      !isNonemptyString(packet.finalText)) {
    return false;
  }
  if (packet.tier === 'YELLOW' &&
      (!isNonemptyString(packet.action.touch) ||
       !isPlainObject(packet.action.opportunity) ||
       !isNonemptyString(packet.action.opportunity.company) ||
       !isNonemptyString(packet.action.opportunity.role))) {
    return false;
  }
  if (!Array.isArray(packet.evidenceIds) || !Array.isArray(packet.evidenceHashes) ||
      packet.evidenceIds.length === 0 || packet.evidenceIds.length !== packet.evidenceHashes.length ||
      !packet.evidenceIds.every(isNonemptyString) ||
      !packet.evidenceHashes.every((hash) => HEX_64.test(hash))) {
    return false;
  }
  if (!HEX_64.test(packet.claimReportHash) ||
      packet.voiceProfile !== VOICE_PROFILE ||
      packet.disclosurePolicy !== DISCLOSURE_POLICY ||
      packet.disclosureIncluded !== true ||
      packet.policyVersion !== POLICY_VERSION ||
      packet.promptVersion !== PROMPT_VERSION ||
      packet.provider !== PROVIDER ||
      packet.model !== MODEL ||
      !HEX_16.test(packet.id) ||
      !HEX_64.test(packet.integritySha256) ||
      !HEX_24.test(packet.idempotencyKey)) {
    return false;
  }
  const createdAt = Date.parse(packet.createdAt);
  const expiresAt = Date.parse(packet.expiresAt);
  return typeof packet.createdAt === 'string' && typeof packet.expiresAt === 'string' &&
    Number.isFinite(createdAt) && Number.isFinite(expiresAt) &&
    expiresAt - createdAt === PACKET_TTL_MS;
}

export function buildPacketIntegrityFields(packet) {
  const integritySha256 = sha256Hex(integrityPayload(packet));
  const idempotencyKey = sha256Hex({
    action: packet.action,
    recipient: packet.recipient,
    finalText: packet.finalText
  }).slice(0, 24);
  return { id: integritySha256.slice(0, 16), integritySha256, idempotencyKey };
}

export function verifyPacketIntegrity(packet, { now = new Date() } = {}) {
  if (!hasValidPacketStructure(packet)) {
    return { ok: false, code: 'BLOCKED_INVALID_PACKET' };
  }
  const expected = buildPacketIntegrityFields(packet);
  if (packet.id !== expected.id || packet.integritySha256 !== expected.integritySha256 ||
      packet.idempotencyKey !== expected.idempotencyKey) {
    return { ok: false, code: 'BLOCKED_INTEGRITY_MISMATCH' };
  }
  if (now.getTime() > Date.parse(packet.expiresAt)) {
    return { ok: false, code: 'BLOCKED_EXPIRED' };
  }
  return { ok: true, code: 'INTEGRITY_OK' };
}
