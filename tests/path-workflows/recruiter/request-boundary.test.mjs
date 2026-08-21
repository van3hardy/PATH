import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRecruiterRequest } from '../../../path-workflows/recruiter/request-boundary.mjs';

const NOW = new Date('2026-07-29T12:00:00Z');
const APPROVED_SENTENCE = 'Van builds agent workflows on Windows 11 with PowerShell.';
const SOURCE_SHA256 = 'a'.repeat(64);

function validRequest() {
  return {
    schemaVersion: 'path.recruiter.request.v1',
    objective: 'draft_first_touch',
    action: { type: 'send_email', channel: 'email', touch: 'first' },
    recipient: { name: 'Recruiter', address: 'private-recipient@example.test' },
    opportunity: { company: 'Synthetic Company', role: 'Synthetic Role' },
    promptVersion: 'path-recruiter-v1',
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    provider: 'fake',
    requestApproval: {
      principal: 'Van',
      approvedAt: '2026-07-29T11:30:00Z',
      scope: 'THIS_REQUEST_ONLY'
    },
    evidenceRefs: [{
      id: 'fact-agent-workflows',
      factKey: 'capability.agent-workflows',
      source: 'cv.md',
      sourceType: 'USER_LAYER_FACT',
      expectedSourceSha256: SOURCE_SHA256,
      quote: APPROVED_SENTENCE,
      authority: 'OWNER_APPROVED_FACT',
      approvedBy: 'Van',
      approvedAt: '2026-07-29T11:00:00Z',
      factRecordedAt: '2026-07-29T10:00:00Z',
      freshness: { mode: 'STATIC' },
      supersedesFactIds: []
    }]
  };
}

function validate(raw) {
  return validateRecruiterRequest(raw, {
    now: () => new Date(NOW),
    idFactory: () => 'run-test-001'
  });
}

function assertInvalid(raw, expectedDetail) {
  let caught;
  assert.throws(() => validate(raw), (error) => {
    caught = error;
    return true;
  });
  assert.equal(caught.code, 'BLOCKED_INVALID_REQUEST');
  assert.ok(Array.isArray(caught.details));
  assert.ok(caught.details.length > 0);
  if (expectedDetail) {
    assert.ok(caught.details.includes(expectedDetail), JSON.stringify(caught.details));
  }
  const serialized = JSON.stringify(caught);
  assert.doesNotMatch(serialized, /private-recipient@example\.test/);
  assert.doesNotMatch(serialized, /Van builds agent workflows/);
}

test('valid request is normalized with generated identifiers and locked constants', () => {
  const valid = validRequest();
  const result = validateRecruiterRequest(valid, {
    now: () => new Date('2026-07-29T12:00:00Z'),
    idFactory: () => 'run-test-001'
  });
  assert.equal(result.runId, 'run-test-001');
  assert.equal(result.objective, 'draft_first_touch');
  assert.equal(result.provider, 'fake');
  assert.equal(result.voiceProfile, 'path-recruiter-persistent-respectful-v1');
  assert.equal(result.disclosurePolicy, 'always-disclose-ai-assistance-v1');
  assert.equal(result.createdAt, '2026-07-29T12:00:00.000Z');
  assert.notStrictEqual(result, valid);
  assert.notStrictEqual(result.recipient, valid.recipient);
  assert.notStrictEqual(result.evidenceRefs[0], valid.evidenceRefs[0]);
});

test('normalized request is deeply frozen and cannot mutate caller input', () => {
  const valid = validRequest();
  const before = structuredClone(valid);
  const result = validate(valid);

  assert.deepEqual(valid, before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.action));
  assert.ok(Object.isFrozen(result.recipient));
  assert.ok(Object.isFrozen(result.opportunity));
  assert.ok(Object.isFrozen(result.requestApproval));
  assert.ok(Object.isFrozen(result.evidenceRefs));
  assert.ok(Object.isFrozen(result.evidenceRefs[0]));
  assert.ok(Object.isFrozen(result.evidenceRefs[0].freshness));
  assert.ok(Object.isFrozen(result.evidenceRefs[0].supersedesFactIds));
  assert.throws(() => { result.recipient.name = 'Mutated'; }, TypeError);
  assert.equal(valid.recipient.name, 'Recruiter');
});

test('provider none is accepted without changing the locked request shape', () => {
  const raw = validRequest();
  raw.provider = 'none';
  raw.runId = 'run-existing-009';
  raw.createdAt = '2026-07-29T09:00:00Z';
  const result = validate(raw);
  assert.equal(result.provider, 'none');
  assert.equal(result.runId, 'run-existing-009');
  assert.equal(result.createdAt, '2026-07-29T09:00:00.000Z');
});

test('provider gemini is accepted as a real provider id', () => {
  const raw = validRequest();
  raw.provider = 'gemini';
  const result = validate(raw);
  assert.equal(result.provider, 'gemini');
});

test('valid reply request is normalized with bounded reply context and threaded action metadata', () => {
  const raw = validRequest();
  raw.objective = 'draft_email_reply';
  raw.action = { type: 'send_email', channel: 'email', touch: 'reply' };
  raw.promptVersion = 'path-reply-v1';
  raw.replyContext = {
    candidateMessageId: 'gmail-message-123',
    originalSubject: 'Re: AI Engineer at Synthetic Company',
    bodySnippet: 'Could you share a few times that work for Van?',
    threadId: 'thread-123',
    inReplyTo: '<gmail-message-123@example.test>',
    references: '<root@example.test> <gmail-message-123@example.test>'
  };

  const result = validate(raw);

  assert.equal(result.objective, 'draft_email_reply');
  assert.equal(result.promptVersion, 'path-reply-v1');
  assert.deepEqual(result.replyContext, raw.replyContext);
  assert.deepEqual(result.action, {
    type: 'send_email',
    channel: 'email',
    touch: 'reply',
    threadId: 'thread-123',
    inReplyTo: '<gmail-message-123@example.test>',
    references: '<root@example.test> <gmail-message-123@example.test>'
  });
  assert.ok(Object.isFrozen(result.replyContext));
});

const invalidCases = [
  ['missing recipient', (raw) => { delete raw.recipient; }, 'recipient'],
  ['empty recipient name', (raw) => { raw.recipient.name = ' '; }, 'recipient.name'],
  ['empty recipient address', (raw) => { raw.recipient.address = ''; }, 'recipient.address'],
  ['unsupported objective', (raw) => { raw.objective = 'mass_outreach'; }, 'objective'],
  ['unsupported action', (raw) => { raw.action.touch = 'follow_up'; }, 'action'],
  ['reply request missing reply context', (raw) => {
    raw.objective = 'draft_email_reply';
    raw.action = { type: 'send_email', channel: 'email', touch: 'reply' };
    raw.promptVersion = 'path-reply-v1';
  }, 'replyContext'],
  ['reply request with raw body context', (raw) => {
    raw.objective = 'draft_email_reply';
    raw.action = { type: 'send_email', channel: 'email', touch: 'reply' };
    raw.promptVersion = 'path-reply-v1';
    raw.replyContext = {
      candidateMessageId: 'gmail-message-123',
      originalSubject: 'Re: AI Engineer at Synthetic Company',
      bodySnippet: 'Could you share a few times that work for Van?',
      rawBody: 'must not cross the request boundary'
    };
  }, 'replyContext.rawBody'],
  ['reply request with unbounded body snippet', (raw) => {
    raw.objective = 'draft_email_reply';
    raw.action = { type: 'send_email', channel: 'email', touch: 'reply' };
    raw.promptVersion = 'path-reply-v1';
    raw.replyContext = {
      candidateMessageId: 'gmail-message-123',
      originalSubject: 'Re: AI Engineer at Synthetic Company',
      bodySnippet: 'x'.repeat(1001)
    };
  }, 'replyContext.bodySnippet'],
  ['unsupported provider', (raw) => { raw.provider = 'remote'; }, 'provider'],
  ['missing opportunity', (raw) => { delete raw.opportunity; }, 'opportunity'],
  ['empty opportunity company', (raw) => { raw.opportunity.company = ''; }, 'opportunity.company'],
  ['empty opportunity role', (raw) => { raw.opportunity.role = ' '; }, 'opportunity.role'],
  ['unknown voice profile', (raw) => { raw.voiceProfile = 'unknown'; }, 'voiceProfile'],
  ['unknown disclosure policy', (raw) => { raw.disclosurePolicy = 'sometimes'; }, 'disclosurePolicy'],
  ['missing request approval', (raw) => { delete raw.requestApproval; }, 'requestApproval'],
  ['wrong request principal', (raw) => { raw.requestApproval.principal = 'Someone Else'; }, 'requestApproval.principal'],
  ['wrong request approval scope', (raw) => { raw.requestApproval.scope = 'ALL_REQUESTS'; }, 'requestApproval.scope'],
  ['future request approval', (raw) => { raw.requestApproval.approvedAt = '2026-07-29T12:00:01Z'; }, 'requestApproval.approvedAt'],
  ['invalid request approval time', (raw) => { raw.requestApproval.approvedAt = 'not-a-date'; }, 'requestApproval.approvedAt'],
  ['non-array evidence references', (raw) => { raw.evidenceRefs = {}; }, 'evidenceRefs'],
  ['empty evidence references', (raw) => { raw.evidenceRefs = []; }, 'evidenceRefs'],
  ['empty evidence quote', (raw) => { raw.evidenceRefs[0].quote = ''; }, 'evidenceRefs[0].quote'],
  ['empty evidence source', (raw) => { raw.evidenceRefs[0].source = ' '; }, 'evidenceRefs[0].source'],
  ['missing evidence fact key', (raw) => { delete raw.evidenceRefs[0].factKey; }, 'evidenceRefs[0].factKey'],
  ['missing evidence id', (raw) => { delete raw.evidenceRefs[0].id; }, 'evidenceRefs[0].id'],
  ['wrong evidence source type', (raw) => { raw.evidenceRefs[0].sourceType = 'STYLE_ONLY'; }, 'evidenceRefs[0].sourceType'],
  ['missing source hash', (raw) => { delete raw.evidenceRefs[0].expectedSourceSha256; }, 'evidenceRefs[0].expectedSourceSha256'],
  ['invalid source hash', (raw) => { raw.evidenceRefs[0].expectedSourceSha256 = 'abc'; }, 'evidenceRefs[0].expectedSourceSha256'],
  ['missing evidence authority', (raw) => { delete raw.evidenceRefs[0].authority; }, 'evidenceRefs[0].authority'],
  ['wrong evidence authority', (raw) => { raw.evidenceRefs[0].authority = 'MODEL_INFERRED'; }, 'evidenceRefs[0].authority'],
  ['missing evidence approver', (raw) => { delete raw.evidenceRefs[0].approvedBy; }, 'evidenceRefs[0].approvedBy'],
  ['wrong evidence approver', (raw) => { raw.evidenceRefs[0].approvedBy = 'Someone Else'; }, 'evidenceRefs[0].approvedBy'],
  ['missing evidence approval time', (raw) => { delete raw.evidenceRefs[0].approvedAt; }, 'evidenceRefs[0].approvedAt'],
  ['future evidence approval time', (raw) => { raw.evidenceRefs[0].approvedAt = '2026-07-29T12:00:01Z'; }, 'evidenceRefs[0].approvedAt'],
  ['missing factual record time', (raw) => { delete raw.evidenceRefs[0].factRecordedAt; }, 'evidenceRefs[0].factRecordedAt'],
  ['future factual record time', (raw) => { raw.evidenceRefs[0].factRecordedAt = '2026-07-29T12:00:01Z'; }, 'evidenceRefs[0].factRecordedAt'],
  ['approval before factual record', (raw) => { raw.evidenceRefs[0].approvedAt = '2026-07-29T09:00:00Z'; }, 'evidenceRefs[0].approvedAt'],
  ['missing freshness', (raw) => { delete raw.evidenceRefs[0].freshness; }, 'evidenceRefs[0].freshness'],
  ['unknown freshness mode', (raw) => { raw.evidenceRefs[0].freshness = { mode: 'FOREVER' }; }, 'evidenceRefs[0].freshness.mode'],
  ['current freshness missing validity time', (raw) => { raw.evidenceRefs[0].freshness = { mode: 'CURRENT' }; }, 'evidenceRefs[0].freshness.validUntil'],
  ['current freshness with invalid validity time', (raw) => { raw.evidenceRefs[0].freshness = { mode: 'CURRENT', validUntil: 'later' }; }, 'evidenceRefs[0].freshness.validUntil'],
  ['missing supersession list', (raw) => { delete raw.evidenceRefs[0].supersedesFactIds; }, 'evidenceRefs[0].supersedesFactIds'],
  ['invalid run ID', (raw) => { raw.runId = 'RUN invalid'; }, 'runId'],
  ['invalid created time', (raw) => { raw.createdAt = 'tomorrow'; }, 'createdAt'],
  ['impossible created date', (raw) => { raw.createdAt = '2026-02-30T12:00:00Z'; }, 'createdAt'],
  ['future created time', (raw) => { raw.createdAt = '2026-07-29T12:00:01Z'; }, 'createdAt'],
  ['unknown schema version', (raw) => { raw.schemaVersion = 'path.recruiter.request.v2'; }, 'schemaVersion'],
  ['unknown prompt version', (raw) => { raw.promptVersion = 'path-recruiter-v2'; }, 'promptVersion'],
  ['unexpected top-level field', (raw) => { raw.massSend = true; }, 'massSend']
];

for (const [name, mutate, detail] of invalidCases) {
  test(`request validation rejects ${name}`, () => {
    const raw = validRequest();
    mutate(raw);
    assertInvalid(raw, detail);
  });
}
