import assert from 'node:assert/strict';
import test from 'node:test';

import { renderRunSummary } from '../../../path-workflows/recruiter/summary-writer.mjs';

const RUN_ID = 'run-test-001';
const PACKET_ID = 'c2ff337ae429db01';

function baseArgs(overrides = {}) {
  return {
    runId: RUN_ID,
    packetId: PACKET_ID,
    classification: {
      counts: { EVIDENCE: 1, REQUEST: 1, TEMPLATE: 2, UNVERIFIED: 0 },
      unverified: []
    },
    ...overrides
  };
}

test('renderRunSummary renders the exact accounting block when nothing is unverified', () => {
  const summary = renderRunSummary(baseArgs());

  assert.equal(summary, `# Path Recruiter Run ${RUN_ID}

- Status: HUMAN_REVIEW
- Result: LOCAL_REVIEW_READY
- Draft: draft.md
- Claim report: claim-report.json
- Approval packet: ${PACKET_ID}
- Safety tier: YELLOW
- Draft segments: 4 - all accounted for
  (1 evidence, 1 from request, 2 template wording)
- External action: NONE — HUMAN REVIEW REQUIRED
`);
});

test('renderRunSummary renders the exact unverified section when segments are unverified', () => {
  const summary = renderRunSummary(baseArgs({
    classification: {
      counts: { EVIDENCE: 1, REQUEST: 1, TEMPLATE: 2, UNVERIFIED: 2 },
      unverified: ['Missing evidence claim.', 'Another unverifiable claim.']
    }
  }));

  assert.equal(summary, `# Path Recruiter Run ${RUN_ID}

- Status: HUMAN_REVIEW
- Result: LOCAL_REVIEW_READY
- Draft: draft.md
- Claim report: claim-report.json
- Approval packet: ${PACKET_ID}
- Safety tier: YELLOW
- Draft segments: 6 - 2 UNVERIFIED
- External action: NONE — HUMAN REVIEW REQUIRED

## Unverified segments

1. "Missing evidence claim."
2. "Another unverifiable claim."
`);
});

test('renderRunSummary throws BLOCKED_INVALID_SUMMARY for a missing classification', () => {
  assert.throws(
    () => renderRunSummary({ runId: RUN_ID, packetId: PACKET_ID }),
    { code: 'BLOCKED_INVALID_SUMMARY' }
  );
});

test('renderRunSummary throws BLOCKED_INVALID_SUMMARY when counts is missing a key', () => {
  assert.throws(
    () => renderRunSummary(baseArgs({
      classification: {
        counts: { EVIDENCE: 1, REQUEST: 1, TEMPLATE: 2 },
        unverified: []
      }
    })),
    { code: 'BLOCKED_INVALID_SUMMARY' }
  );
});

test('renderRunSummary throws BLOCKED_INVALID_SUMMARY when unverified is not an array', () => {
  assert.throws(
    () => renderRunSummary(baseArgs({
      classification: {
        counts: { EVIDENCE: 1, REQUEST: 1, TEMPLATE: 2, UNVERIFIED: 0 },
        unverified: 'none'
      }
    })),
    { code: 'BLOCKED_INVALID_SUMMARY' }
  );
});

test('renderRunSummary throws BLOCKED_INVALID_SUMMARY for a bad runId', () => {
  assert.throws(
    () => renderRunSummary(baseArgs({ runId: 'not-a-run-id' })),
    { code: 'BLOCKED_INVALID_SUMMARY' }
  );
});

test('renderRunSummary throws BLOCKED_INVALID_SUMMARY for a bad packetId', () => {
  assert.throws(
    () => renderRunSummary(baseArgs({ packetId: 'not-hex' })),
    { code: 'BLOCKED_INVALID_SUMMARY' }
  );
});

test('renderRunSummary throws BLOCKED_INVALID_SUMMARY when all counts are zero', () => {
  assert.throws(
    () => renderRunSummary(baseArgs({
      classification: {
        counts: { EVIDENCE: 0, REQUEST: 0, TEMPLATE: 0, UNVERIFIED: 0 },
        unverified: []
      }
    })),
    { code: 'BLOCKED_INVALID_SUMMARY' }
  );
});
