const RUN_ID = /^run-[a-z0-9-]+$/;
const PACKET_ID = /^[a-f0-9]{16}$/;

const COUNT_KEYS = ['EVIDENCE', 'REQUEST', 'TEMPLATE', 'UNVERIFIED'];

export function renderRunSummary({ runId, packetId, classification, contactNote } = {}) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) ||
      typeof packetId !== 'string' || !PACKET_ID.test(packetId) ||
      !isRecord(classification) || !isRecord(classification.counts) ||
      !COUNT_KEYS.every((key) => Number.isInteger(classification.counts[key]) &&
        classification.counts[key] >= 0) ||
      !Array.isArray(classification.unverified)) {
    throw codedError('BLOCKED_INVALID_SUMMARY');
  }
  if (contactNote != null && typeof contactNote !== 'string') {
    throw codedError('BLOCKED_INVALID_SUMMARY');
  }

  const { EVIDENCE, REQUEST, TEMPLATE, UNVERIFIED } = classification.counts;
  const total = EVIDENCE + REQUEST + TEMPLATE + UNVERIFIED;
  if (total === 0) {
    throw codedError('BLOCKED_INVALID_SUMMARY');
  }
  const accounting = UNVERIFIED === 0
    ? `- Draft segments: ${total} - all accounted for
  (${EVIDENCE} evidence, ${REQUEST} from request, ${TEMPLATE} template wording)`
    : `- Draft segments: ${total} - ${UNVERIFIED} UNVERIFIED`;

  const unverifiedSection = UNVERIFIED === 0 ? '' : `
## Unverified segments

${classification.unverified.map((text, index) => `${index + 1}. ${JSON.stringify(text)}`).join('\n')}
`;

  const contactLine = contactNote == null || contactNote.trim().length === 0
    ? ''
    : `- Contact history: ${contactNote.trim()}
`;

  return `# Path Recruiter Run ${runId}

- Status: HUMAN_REVIEW
- Result: LOCAL_REVIEW_READY
- Draft: draft.md
- Claim report: claim-report.json
- Approval packet: ${packetId}
- Safety tier: YELLOW
${accounting}
- External action: NONE — HUMAN REVIEW REQUIRED
${contactLine}${unverifiedSection}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
