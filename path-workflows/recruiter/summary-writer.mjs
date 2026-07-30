const RUN_ID = /^run-[a-z0-9-]+$/;
const PACKET_ID = /^[a-f0-9]{16}$/;

export function renderRunSummary({ runId, packetId } = {}) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) ||
      typeof packetId !== 'string' || !PACKET_ID.test(packetId)) {
    throw codedError('BLOCKED_INVALID_SUMMARY');
  }
  return `# Path Recruiter Run ${runId}

- Status: HUMAN_REVIEW
- Result: LOCAL_REVIEW_READY
- Draft: draft.md
- Claim report: claim-report.json
- Approval packet: ${packetId}
- Safety tier: YELLOW
- External action: NONE — HUMAN REVIEW REQUIRED
`;
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
