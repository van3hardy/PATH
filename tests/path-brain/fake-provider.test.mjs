import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeProvider } from '../../path-brain/fake-provider.mjs';
import { renderRecruiterTemplate } from '../../path-brain/recruiter-template.mjs';

const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';
const CLAIM = 'Van builds agent workflows on Windows 11 with PowerShell.';
const EXACT_TEXT = `Hello Hiring Manager,

I'm reaching out on Van's behalf about the AI Engineer opportunity at Example Company.

Van builds agent workflows on Windows 11 with PowerShell.

If this background may be relevant, would you be open to a conversation?

Best,
Van
Prepared with Path, Van's AI recruiting assistant.`;

function validInput() {
  return {
    schemaVersion: 'path.brain.request.v1',
    promptVersion: 'path-recruiter-v1',
    objective: 'draft_first_touch',
    recipient: { name: 'Hiring Manager', address: 'hiring@example.test' },
    opportunity: { company: 'Example Company', role: 'AI Engineer' },
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    evidence: [{
      id: 'fact-1',
      factKey: 'workflow-platform',
      source: 'cv.md',
      quote: CLAIM
    }]
  };
}

test('renderRecruiterTemplate returns the exact fixed complete recruiter draft', () => {
  assert.deepEqual(renderRecruiterTemplate(validInput()), {
    text: EXACT_TEXT,
    claims: [CLAIM],
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    disclosureIncluded: true
  });
});

test('fakeProvider returns the exact deterministic output', async () => {
  assert.deepEqual(await fakeProvider.generate(validInput()), {
    schemaVersion: 'path.brain.output.v1',
    provider: 'fake',
    model: 'deterministic-recruiter-template-v1',
    promptVersion: 'path-recruiter-v1',
    text: EXACT_TEXT,
    claims: [CLAIM],
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    disclosureIncluded: true
  });
});

test('fixed template preserves multiple selected atomic claims in order', () => {
  const input = validInput();
  const secondClaim = 'Van uses deterministic safety gates for outbound work.';
  input.evidence.push({
    id: 'fact-2',
    factKey: 'safety-gates',
    source: 'article-digest.md',
    quote: secondClaim
  });

  const result = renderRecruiterTemplate(input);

  assert.deepEqual(result.claims, [CLAIM, secondClaim]);
  assert.equal(result.text, `Hello Hiring Manager,

I'm reaching out on Van's behalf about the AI Engineer opportunity at Example Company.

${CLAIM}

${secondClaim}

If this background may be relevant, would you be open to a conversation?

Best,
Van
Prepared with Path, Van's AI recruiting assistant.`);
});

test('fakeProvider blocks empty selected evidence', async () => {
  const input = validInput();
  input.evidence = [];
  await assert.rejects(
    fakeProvider.generate(input),
    (error) => error.code === 'BLOCKED_NO_SELECTED_EVIDENCE'
  );
});

test('fixed template blocks missing or unknown voice and disclosure values', () => {
  const invalidCases = [
    ['voiceProfile', undefined],
    ['voiceProfile', 'unknown-voice'],
    ['disclosurePolicy', undefined],
    ['disclosurePolicy', 'sometimes-disclose']
  ];
  for (const [key, value] of invalidCases) {
    const input = validInput();
    input[key] = value;
    assert.throws(
      () => renderRecruiterTemplate(input),
      (error) => error.code === 'BLOCKED_INVALID_BRAIN_INPUT'
    );
  }
});

test('fixed template blocks missing recipient, company, or role', () => {
  const invalidInputs = [
    () => { const input = validInput(); input.recipient.name = ' '; return input; },
    () => { const input = validInput(); input.opportunity.company = ''; return input; },
    () => { const input = validInput(); input.opportunity.role = undefined; return input; }
  ];
  for (const createInput of invalidInputs) {
    assert.throws(
      () => renderRecruiterTemplate(createInput()),
      (error) => error.code === 'BLOCKED_INVALID_BRAIN_INPUT'
    );
  }
});

test('fixed template blocks non-atomic selected evidence', () => {
  const input = validInput();
  input.evidence[0].quote = 'Van builds agents. Van runs production systems.';
  assert.throws(
    () => renderRecruiterTemplate(input),
    (error) => error.code === 'BLOCKED_INVALID_BRAIN_INPUT'
  );
});

test('fixed template rejects arbitrary style prompts and extra evidence metadata', () => {
  const withStyle = validInput();
  withStyle.stylePrompt = 'be aggressive';
  assert.throws(
    () => renderRecruiterTemplate(withStyle),
    (error) => error.code === 'BLOCKED_INVALID_BRAIN_INPUT'
  );

  const withMetadata = validInput();
  withMetadata.evidence[0].rawSourceText = 'unselected source text';
  assert.throws(
    () => renderRecruiterTemplate(withMetadata),
    (error) => error.code === 'BLOCKED_INVALID_BRAIN_INPUT'
  );
});
