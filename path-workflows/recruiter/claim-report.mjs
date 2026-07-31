import crypto from 'node:crypto';

import { resolveClaims, splitClaims } from '../../path-safety/fact-resolver.mjs';
import { classifyDraft } from './draft-classifier.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';

export function buildClaimReport({ brainOutput, selection, request } = {}) {
  validateBrainOutput(brainOutput);
  validateSelection(selection);

  const facts = {
    facts: selection.items.map((item) => ({
      id: item.id,
      text: item.quote,
      source: item.source,
      source_date: item.factRecordedAt,
      approved: true
    }))
  };
  const result = resolveClaims(brainOutput.claims.join(' '), facts);

  const draftClassification = classifyDraft({
    text: brainOutput.text,
    evidenceItems: selection.items,
    request
  });

  return {
    schemaVersion: 'path.claim-report.v2',
    draftSha256: sha256(brainOutput.text),
    declaredClaims: [...brainOutput.claims],
    supported: result.supported,
    unsupported: result.unsupported,
    evidenceIds: selection.items.map((item) => item.id),
    draftClassification,
    voiceProfile: brainOutput.voiceProfile,
    disclosurePolicy: brainOutput.disclosurePolicy,
    status: result.unsupported.length === 0
      ? 'SUPPORTED'
      : 'BLOCKED_UNSUPPORTED_CLAIMS'
  };
}

function validateBrainOutput(output) {
  if (!isRecord(output) || output.schemaVersion !== 'path.brain.output.v1' ||
      output.voiceProfile !== VOICE_PROFILE ||
      output.disclosurePolicy !== DISCLOSURE_POLICY ||
      output.disclosureIncluded !== true ||
      !Array.isArray(output.claims) || output.claims.length === 0 ||
      output.claims.some((claim) => typeof claim !== 'string' ||
        splitClaims(claim).length !== 1 || splitClaims(claim)[0] !== claim.trim()) ||
      typeof output.text !== 'string' || output.text.trim().length === 0) {
    throw codedError('FAILED_BRAIN_OUTPUT_INVALID');
  }
  const draft = normalizeClaimText(output.text);
  if (!output.claims.every((claim) => draft.includes(normalizeClaimText(claim)))) {
    throw codedError('FAILED_BRAIN_OUTPUT_INVALID');
  }
}

function validateSelection(selection) {
  if (!isRecord(selection) || selection.schemaVersion !== 'path.evidence-selection.v1' ||
      !validTimestamp(selection.inspectedAt) || !Array.isArray(selection.items) ||
      selection.items.length === 0 || !Array.isArray(selection.supersededEvidenceIds)) {
    throw codedError('BLOCKED_INVALID_EVIDENCE');
  }
  const inspectedAt = Date.parse(selection.inspectedAt);
  const ids = new Set();
  const quotesByFactKey = new Map();
  for (const item of selection.items) {
    if (!isRecord(item) || !nonempty(item.id) || ids.has(item.id) ||
        !nonempty(item.factKey) || !nonempty(item.source) ||
        !SHA256.test(item.sourceSha256) || !validTimestamp(item.sourceModifiedAt) ||
        !nonempty(item.quote) || splitClaims(item.quote).length !== 1 ||
        item.authority !== 'OWNER_APPROVED_FACT' || item.approvedBy !== 'Van' ||
        !validTimestamp(item.approvedAt) || !validTimestamp(item.factRecordedAt) ||
        Date.parse(item.approvedAt) > inspectedAt ||
        Date.parse(item.factRecordedAt) > Date.parse(item.approvedAt) ||
        !validFreshness(item.freshness, inspectedAt)) {
      throw codedError('BLOCKED_INVALID_EVIDENCE');
    }
    const normalizedQuote = item.quote.trim().replace(/\s+/g, ' ').toLowerCase();
    if (quotesByFactKey.has(item.factKey) &&
        quotesByFactKey.get(item.factKey) !== normalizedQuote) {
      throw codedError('UNRESOLVED_CONFLICTING_EVIDENCE');
    }
    quotesByFactKey.set(item.factKey, normalizedQuote);
    ids.add(item.id);
  }
  if (selection.supersededEvidenceIds.some((id) => !nonempty(id) || ids.has(id))) {
    throw codedError('BLOCKED_INVALID_EVIDENCE');
  }
}

function validFreshness(freshness, inspectedAt) {
  if (!isRecord(freshness)) return false;
  if (freshness.mode === 'STATIC') return Object.keys(freshness).length === 1;
  return freshness.mode === 'CURRENT' && Object.keys(freshness).length === 2 &&
    validTimestamp(freshness.validUntil) && Date.parse(freshness.validUntil) >= inspectedAt;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeClaimText(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
