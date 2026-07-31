import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClaimReport } from '../../../path-workflows/recruiter/claim-report.mjs';

const CLAIM = 'Van builds agent workflows on Windows 11 with PowerShell.';
const DRAFT = `Hello Hiring Manager,

I'm reaching out on Van's behalf about the AI Engineer opportunity at Example Company.

Van builds agent workflows on Windows 11 with PowerShell.

If this background may be relevant, would you be open to a conversation?

Best,
Van
Prepared with Path, Van's AI recruiting assistant.`;

function brainOutput(overrides = {}) {
  return {
    schemaVersion: 'path.brain.output.v1',
    provider: 'fake',
    model: 'deterministic-recruiter-template-v1',
    promptVersion: 'path-recruiter-v1',
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    disclosureIncluded: true,
    claims: [CLAIM],
    text: DRAFT,
    ...overrides
  };
}

function selection(overrides = {}) {
  return {
    schemaVersion: 'path.evidence-selection.v1',
    inspectedAt: '2026-07-29T12:00:00.000Z',
    items: [{
      id: 'fact-agent-workflows',
      factKey: 'capability.agent-workflows',
      source: 'cv.md',
      sourceSha256: 'a'.repeat(64),
      sourceModifiedAt: '2026-07-29T11:45:00.000Z',
      quote: CLAIM,
      authority: 'OWNER_APPROVED_FACT',
      approvedBy: 'Van',
      approvedAt: '2026-07-29T11:00:00.000Z',
      factRecordedAt: '2026-07-29T10:00:00.000Z',
      freshness: { mode: 'STATIC' }
    }],
    supersededEvidenceIds: [],
    ...overrides
  };
}

test('buildClaimReport derives an exact supported report from validated selected evidence', () => {
  const report = buildClaimReport({
    brainOutput: brainOutput(),
    selection: selection(),
    request: {
      recipient: { name: 'Hiring Manager' },
      opportunity: { company: 'Example Company', role: 'AI Engineer' }
    }
  });

  assert.equal(report.schemaVersion, 'path.claim-report.v2');
  assert.equal(report.draftSha256,
    '6168c4e05682895f2684faee883d29a95aaed784ec827bbb366fc4dffd7354a4');
  assert.deepEqual(report.declaredClaims, [CLAIM]);
  assert.deepEqual(report.supported, [CLAIM]);
  assert.deepEqual(report.unsupported, []);
  assert.deepEqual(report.evidenceIds, ['fact-agent-workflows']);
  assert.equal(report.status, 'SUPPORTED');
  assert.deepEqual(report.draftClassification.unverified, []);
  assert.equal(report.draftClassification.counts.UNVERIFIED, 0);
  assert.equal(report.voiceProfile, 'path-recruiter-persistent-respectful-v1');
  assert.equal(report.disclosurePolicy, 'always-disclose-ai-assistance-v1');
  assert.deepEqual(Object.keys(report).sort(), [
    'declaredClaims', 'disclosurePolicy', 'draftClassification', 'draftSha256',
    'evidenceIds', 'schemaVersion', 'status', 'supported', 'unsupported', 'voiceProfile'
  ]);
});

test('buildClaimReport reports a declared claim absent from selection as unsupported', () => {
  const unsupported = 'Van invented an unsupported claim.';
  const report = buildClaimReport({
    brainOutput: brainOutput({
      claims: [unsupported],
      text: DRAFT.replace(CLAIM, unsupported)
    }),
    selection: selection(),
    request: {
      recipient: { name: 'Hiring Manager' },
      opportunity: { company: 'Example Company', role: 'AI Engineer' }
    }
  });

  assert.deepEqual(report.declaredClaims, [unsupported]);
  assert.deepEqual(report.supported, []);
  assert.deepEqual(report.unsupported, [unsupported]);
  assert.equal(report.status, 'BLOCKED_UNSUPPORTED_CLAIMS');
});

test('buildClaimReport never derives approval from file location alone', () => {
  const invalid = selection();
  invalid.items[0] = {
    ...invalid.items[0],
    authority: 'MODEL_INFERRED',
    approvedBy: 'Someone Else'
  };

  assert.throws(() => buildClaimReport({
    brainOutput: brainOutput(),
    selection: invalid,
    request: {
      recipient: { name: 'Hiring Manager' },
      opportunity: { company: 'Example Company', role: 'AI Engineer' }
    }
  }), { code: 'BLOCKED_INVALID_EVIDENCE' });
});

test('buildClaimReport rejects unresolved conflicting values for one fact key', () => {
  const conflicting = selection();
  conflicting.items.push({
    ...conflicting.items[0],
    id: 'fact-agent-workflows-conflict',
    quote: 'Van does not build agent workflows.'
  });

  assert.throws(() => buildClaimReport({
    brainOutput: brainOutput(),
    selection: conflicting,
    request: {
      recipient: { name: 'Hiring Manager' },
      opportunity: { company: 'Example Company', role: 'AI Engineer' }
    }
  }), { code: 'UNRESOLVED_CONFLICTING_EVIDENCE' });
});
