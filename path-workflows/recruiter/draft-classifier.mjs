import { renderRequestFrame, TEMPLATE_SEGMENTS } from '../../path-brain/recruiter-template.mjs';
import { normalizeText, splitClaims } from '../../path-safety/fact-resolver.mjs';

export function classifyDraft({ text, evidenceItems, request } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0 ||
      !Array.isArray(evidenceItems) || evidenceItems.length === 0 ||
      !evidenceItems.every((item) => isRecord(item) &&
        nonempty(item.id) && nonempty(item.quote)) ||
      !isRecord(request) || !isRecord(request.recipient) ||
      !isRecord(request.opportunity) || !nonempty(request.recipient.name) ||
      !nonempty(request.opportunity.company) || !nonempty(request.opportunity.role)) {
    throw codedError('FAILED_DRAFT_CLASSIFICATION');
  }

  const evidenceById = new Map(
    evidenceItems.map((item) => [normalizeText(item.quote), item.id])
  );
  const requestSegments = new Set(
    splitClaims(renderRequestFrame(request)).map(normalizeText)
  );
  const templateSegments = new Set(
    TEMPLATE_SEGMENTS.flatMap((segment) => splitClaims(segment)).map(normalizeText)
  );

  const segments = splitClaims(text).map((segment) => {
    const key = normalizeText(segment);
    if (evidenceById.has(key)) {
      return { text: segment, label: 'EVIDENCE', evidenceId: evidenceById.get(key) };
    }
    if (requestSegments.has(key)) return { text: segment, label: 'REQUEST' };
    if (templateSegments.has(key)) return { text: segment, label: 'TEMPLATE' };
    return { text: segment, label: 'UNVERIFIED' };
  });

  const counts = { EVIDENCE: 0, REQUEST: 0, TEMPLATE: 0, UNVERIFIED: 0 };
  for (const segment of segments) counts[segment.label] += 1;

  return {
    segments,
    counts,
    unverified: segments.filter((s) => s.label === 'UNVERIFIED').map((s) => s.text)
  };
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
