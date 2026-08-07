import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDraft } from '../../../path-workflows/recruiter/draft-classifier.mjs';
import { renderRecruiterTemplate } from '../../../path-brain/recruiter-template.mjs';

const CLAIM = 'Van builds agent workflows on Windows 11 with PowerShell.';

function request() {
  return {
    recipient: { name: 'Hiring Manager' },
    opportunity: { company: 'Example Company', role: 'AI Engineer' }
  };
}

function evidenceItems() {
  return [{ id: 'fact-agent-workflows', quote: CLAIM }];
}

function templateDraft() {
  return renderRecruiterTemplate({
    schemaVersion: 'path.brain.request.v1',
    promptVersion: 'path-recruiter-v1',
    objective: 'draft_first_touch',
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    ...request(),
    evidence: [{
      id: 'fact-agent-workflows',
      factKey: 'capability.agent-workflows',
      source: 'cv.md',
      quote: CLAIM
    }]
  }).text;
}

// T1 - anti-drift
test('template output classifies with zero unverified segments', () => {
  const result = classifyDraft({
    text: templateDraft(),
    evidenceItems: evidenceItems(),
    request: request()
  });
  assert.deepEqual(result.unverified, []);
  assert.equal(result.counts.UNVERIFIED, 0);
  assert.equal(result.counts.EVIDENCE, 1);
  assert.equal(result.counts.REQUEST, 1);
  assert.equal(result.counts.TEMPLATE, 2);
  assert.equal(result.segments.length, 4);
});

// T6 - evidence carries its id
test('an evidence segment is labelled EVIDENCE and carries its evidenceId', () => {
  const result = classifyDraft({
    text: templateDraft(),
    evidenceItems: evidenceItems(),
    request: request()
  });
  const evidence = result.segments.filter((s) => s.label === 'EVIDENCE');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].text, CLAIM);
  assert.equal(evidence[0].evidenceId, 'fact-agent-workflows');
});

// T5 - request-derived is not confused with template or evidence
test('the greeting and role/company segment is labelled REQUEST', () => {
  const result = classifyDraft({
    text: templateDraft(),
    evidenceItems: evidenceItems(),
    request: request()
  });
  const requestSegments = result.segments.filter((s) => s.label === 'REQUEST');
  assert.equal(requestSegments.length, 1);
  assert.match(requestSegments[0].text, /Example Company/);
  assert.equal(requestSegments[0].evidenceId, undefined);
});

// T4 - fabrication surfaces
test('a fabricated segment is labelled UNVERIFIED', () => {
  const fabricated = 'Van led a 12-person ML platform team at Google.';
  const result = classifyDraft({
    text: `${templateDraft()}\n\n${fabricated}`,
    evidenceItems: evidenceItems(),
    request: request()
  });
  assert.deepEqual(result.unverified, [fabricated]);
  assert.equal(result.counts.UNVERIFIED, 1);
});

test('classification is case and whitespace insensitive', () => {
  const result = classifyDraft({
    text: `  ${CLAIM.toUpperCase()}  `,
    evidenceItems: evidenceItems(),
    request: request()
  });
  assert.equal(result.counts.EVIDENCE, 1);
  assert.equal(result.counts.UNVERIFIED, 0);
});

test('classifyDraft throws FAILED_DRAFT_CLASSIFICATION on malformed input', () => {
  const cases = [
    { text: '', evidenceItems: evidenceItems(), request: request() },
    { text: templateDraft(), evidenceItems: [], request: request() },
    { text: templateDraft(), evidenceItems: evidenceItems(), request: {} },
    undefined
  ];
  for (const input of cases) {
    assert.throws(() => classifyDraft(input), (error) => {
      assert.equal(error.code, 'FAILED_DRAFT_CLASSIFICATION');
      return true;
    });
  }
});
