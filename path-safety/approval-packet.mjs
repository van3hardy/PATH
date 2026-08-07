import { classifyAction } from './policy.mjs';
import { resolveClaims, splitClaims } from './fact-resolver.mjs';
import {
  buildPacketIntegrityFields,
  sha256Hex,
  stableStringify,
  verifyPacketIntegrity
} from './packet-integrity.mjs';

const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';
const POLICY_VERSION = 'path-safety-v1';

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function validateClaims(claims) {
  if (!Array.isArray(claims) || claims.length === 0 || !claims.every((claim) =>
    typeof claim === 'string' && claim.trim().length > 0 &&
    splitClaims(claim).length === 1 && splitClaims(claim)[0] === claim.trim())) {
    throw codedError('BLOCKED_INVALID_CLAIMS');
  }
}

function validateDisclosure(input) {
  if (input.voiceProfile !== VOICE_PROFILE ||
      input.disclosurePolicy !== DISCLOSURE_POLICY ||
      input.disclosureIncluded !== true) {
    throw codedError('BLOCKED_INVALID_DISCLOSURE_POLICY');
  }
}

function validateEvidence(input) {
  if (!Array.isArray(input.evidenceIds) || !Array.isArray(input.evidenceHashes) ||
      input.evidenceIds.length === 0 ||
      input.evidenceIds.length !== input.evidenceHashes.length ||
      !input.evidenceIds.every((id) => typeof id === 'string' && id.trim().length > 0) ||
      !input.evidenceHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)) ||
      !/^[a-f0-9]{64}$/.test(input.claimReportHash)) {
    throw codedError('BLOCKED_INVALID_PACKET');
  }
}

function canonicalAction(input) {
  const action = input.action && typeof input.action === 'object' && !Array.isArray(input.action)
    ? { ...input.action }
    : input.action;
  const topLevel = input.opportunity;
  const nested = action?.opportunity;
  if (topLevel !== undefined && nested !== undefined &&
      stableStringify(topLevel) !== stableStringify(nested)) {
    throw codedError('BLOCKED_INVALID_PACKET');
  }
  const opportunity = topLevel ?? nested;
  if (action && opportunity !== undefined) action.opportunity = opportunity;
  return action;
}

function validateRecruiterContext(action, classification) {
  if (classification.tier !== 'YELLOW') return;
  if (typeof action?.touch !== 'string' || action.touch.trim().length === 0 ||
      !action.opportunity || typeof action.opportunity !== 'object' ||
      Array.isArray(action.opportunity) ||
      typeof action.opportunity.company !== 'string' ||
      action.opportunity.company.trim().length === 0 ||
      typeof action.opportunity.role !== 'string' ||
      action.opportunity.role.trim().length === 0) {
    throw codedError('BLOCKED_INVALID_PACKET');
  }
}

export function buildApprovalPacket(input, { now = () => new Date() } = {}) {
  validateClaims(input.claims);
  validateDisclosure(input);
  validateEvidence(input);

  const createdAt = now().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString();
  const claimResult = resolveClaims(input.claims.join(' '), input.facts);
  const action = canonicalAction(input);
  const baseClassification = classifyAction({ ...action, text: input.text });
  validateRecruiterContext(action, baseClassification);
  if (claimResult.unsupported.length > 0) {
    throw codedError('BLOCKED_UNSUPPORTED_CLAIMS', {
      unsupportedCount: claimResult.unsupported.length,
      unsupportedHashes: claimResult.unsupported.map(sha256Hex)
    });
  }
  const classification = baseClassification;
  const claimReportHash = input.claimReportHash || sha256Hex(claimResult);

  const packet = {
    status: classification.tier === 'YELLOW' ? 'AWAITING_VAN_APPROVAL' : classification.tier,
    tier: classification.tier,
    reasons: classification.reasons,
    action,
    recipient: input.recipient,
    finalText: input.text,
    evidenceIds: Array.isArray(input.evidenceIds) ? [...input.evidenceIds] : input.evidenceIds,
    evidenceHashes: Array.isArray(input.evidenceHashes)
      ? [...input.evidenceHashes]
      : input.evidenceHashes,
    claimReportHash,
    voiceProfile: input.voiceProfile,
    disclosurePolicy: input.disclosurePolicy,
    disclosureIncluded: input.disclosureIncluded,
    promptVersion: input.promptVersion,
    provider: input.provider,
    model: input.model,
    policyVersion: POLICY_VERSION,
    createdAt,
    expiresAt,
    supportedClaims: claimResult.supported,
    unsupportedClaims: claimResult.unsupported
  };

  const boundPacket = { ...packet, ...buildPacketIntegrityFields(packet) };
  const verification = verifyPacketIntegrity(boundPacket, { now: new Date(createdAt) });
  if (!verification.ok) throw codedError(verification.code);
  return boundPacket;
}
