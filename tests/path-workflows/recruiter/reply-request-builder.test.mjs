import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReplyRequestFromCandidate,
  MAX_REPLY_SNIPPET_CHARS
} from '../../../path-workflows/recruiter/reply-request-builder.mjs';
import { validateRecruiterRequest } from '../../../path-workflows/recruiter/request-boundary.mjs';

const NOW = new Date('2026-07-29T12:00:00Z');
const CLAIM = 'Van builds agent workflows on Windows 11 with PowerShell.';
const SOURCE_SHA256 = 'a'.repeat(64);

function candidate(overrides = {}) {
  return {
    message_id: 'gmail-message-123',
    from: 'Recruiter <recruiter@example.test>',
    subject: 'Re: AI Engineer at Example Company',
    body_snippet: 'Could you share a few times that work for Van?',
    signal: null,
    thread_id: 'thread-123',
    message_id_header: '<gmail-message-123@example.test>',
    references: '<root@example.test>',
    ...overrides
  };
}

function context(overrides = {}) {
  return {
    opportunity: { company: 'Example Company', role: 'AI Engineer' },
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
      quote: CLAIM,
      authority: 'OWNER_APPROVED_FACT',
      approvedBy: 'Van',
      approvedAt: '2026-07-29T11:00:00Z',
      factRecordedAt: '2026-07-29T10:00:00Z',
      freshness: { mode: 'STATIC' },
      supersedesFactIds: []
    }],
    ...overrides
  };
}

test('buildReplyRequestFromCandidate converts a scanner candidate into a validated reply request', () => {
  const raw = buildReplyRequestFromCandidate(candidate(), context(), {
    now: () => new Date(NOW),
    idFactory: () => 'run-reply-001'
  });
  const request = validateRecruiterRequest(raw, {
    now: () => new Date(NOW),
    idFactory: () => 'unused'
  });

  assert.equal(request.runId, 'run-reply-001');
  assert.equal(request.objective, 'draft_email_reply');
  assert.equal(request.promptVersion, 'path-reply-v1');
  assert.deepEqual(request.recipient, {
    name: 'Recruiter',
    address: 'recruiter@example.test'
  });
  assert.deepEqual(request.replyContext, {
    candidateMessageId: 'gmail-message-123',
    originalSubject: 'Re: AI Engineer at Example Company',
    bodySnippet: 'Could you share a few times that work for Van?',
    threadId: 'thread-123',
    inReplyTo: '<gmail-message-123@example.test>',
    references: '<root@example.test> <gmail-message-123@example.test>'
  });
  assert.equal(request.action.threadId, 'thread-123');
  assert.equal(request.action.inReplyTo, '<gmail-message-123@example.test>');
  assert.equal(request.action.references, '<root@example.test> <gmail-message-123@example.test>');
});

test('buildReplyRequestFromCandidate bounds snippets and rejects raw body leakage', () => {
  const raw = buildReplyRequestFromCandidate(candidate({
    body_snippet: 'x'.repeat(MAX_REPLY_SNIPPET_CHARS + 50),
    raw_body: 'must-not-cross-boundary'
  }), context(), {
    now: () => new Date(NOW),
    idFactory: () => 'run-reply-001'
  });

  assert.equal(raw.replyContext.bodySnippet.length, MAX_REPLY_SNIPPET_CHARS);
  assert.equal(Object.hasOwn(raw.replyContext, 'raw_body'), false);
  assert.equal(Object.hasOwn(raw.replyContext, 'rawBody'), false);
});

test('buildReplyRequestFromCandidate fails closed on malformed candidates', () => {
  assert.throws(() => buildReplyRequestFromCandidate(candidate({ message_id: '' }), context()), {
    code: 'BLOCKED_INVALID_REPLY_CANDIDATE'
  });
  assert.throws(() => buildReplyRequestFromCandidate(candidate(), context({ evidenceRefs: [] })), {
    code: 'BLOCKED_INVALID_REPLY_CONTEXT'
  });
});
