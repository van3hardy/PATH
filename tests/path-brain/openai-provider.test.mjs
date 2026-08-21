import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOpenAIProvider } from '../../path-brain/openai-provider.mjs';
import { DEFAULT_OPENAI_MODEL } from '../../path-brain/provider-ids.mjs';
import {
  buildCapabilityIntent,
  createCapabilityApprovalAuthority,
  approveCapability
} from '../../path-safety/capability-gateway.mjs';
import {
  createJsonlReceiptSink,
  verifyCapabilityReceipts
} from '../../path-safety/capability-receipts.mjs';

const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';
const CLAIM = 'Van builds agent workflows on Windows 11 with PowerShell.';
const NOW = new Date('2026-07-29T12:00:00.000Z');
const APPROVED_AT = new Date('2026-07-29T11:30:00.000Z');

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

function validReplyInput() {
  return {
    schemaVersion: 'path.brain.request.v1',
    promptVersion: 'path-reply-v1',
    objective: 'draft_email_reply',
    recipient: { name: 'Recruiter', address: 'recruiter@example.test' },
    opportunity: { company: 'Example Company', role: 'AI Engineer' },
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    replyContext: {
      candidateMessageId: 'gmail-message-123',
      originalSubject: 'AI Engineer @ Example Company',
      bodySnippet: 'Could you share a few times that work for Van?',
      threadId: 'thread-123',
      inReplyTo: '<original@example.test>',
      references: '<root@example.test> <original@example.test>'
    },
    evidence: [{
      id: 'fact-1',
      factKey: 'workflow-platform',
      source: 'cv.md',
      quote: CLAIM
    }]
  };
}

function textTransport(text) {
  return async () => ({ text });
}

test('createOpenAIProvider returns a frozen provider with generate', () => {
  const provider = createOpenAIProvider({ transport: textTransport(CLAIM) });
  assert.equal(typeof provider.generate, 'function');
  assert.ok(Object.isFrozen(provider));
});

test('openai provider returns exact contract-shaped output for a verbatim evidence draft', async () => {
  const text = `Hello Hiring Manager,

I'm reaching out on Van's behalf about the AI Engineer opportunity at Example Company.

${CLAIM}

If this background may be relevant, would you be open to a conversation?

Best,
Van
Prepared with Path, Van's AI recruiting assistant.`;
  const provider = createOpenAIProvider({ transport: textTransport(text) });
  const output = await provider.generate(validInput());

  assert.deepEqual(output, {
    schemaVersion: 'path.brain.output.v1',
    provider: 'openai',
    model: DEFAULT_OPENAI_MODEL,
    promptVersion: 'path-recruiter-v1',
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    disclosureIncluded: true,
    claims: [CLAIM],
    text
  });
  assert.ok(Object.isFrozen(output));
  assert.ok(Object.isFrozen(output.claims));
});

test('openai provider honors an explicit model override', async () => {
  const provider = createOpenAIProvider({
    transport: textTransport(CLAIM),
    model: 'gpt-4.1'
  });
  const output = await provider.generate(validInput());
  assert.equal(output.model, 'gpt-4.1');
});

test('openai provider drafts reply prompts and returns reply promptVersion', async () => {
  let prompt;
  const provider = createOpenAIProvider({
    transport: async (request) => {
      prompt = request.prompt;
      return { text: `Hello Recruiter,\n\n${CLAIM}\n\nBest, Van` };
    },
    objective: 'draft_email_reply'
  });

  const output = await provider.generate(validReplyInput());

  assert.equal(output.promptVersion, 'path-reply-v1');
  assert.deepEqual(output.claims, [CLAIM]);
  assert.ok(prompt.includes('drafting a reply email'));
  assert.ok(prompt.includes('Original subject: AI Engineer @ Example Company'));
  assert.ok(prompt.includes('Original message snippet: Could you share a few times that work for Van?'));
});

test('openai provider uses declared claims filtered to approved quotes present in text', async () => {
  const transport = async () => ({
    text: `Hello,

${CLAIM}

Best, Van Prepared with Path, Van's AI recruiting assistant.`,
    claims: [CLAIM, 'Van built an open-source framework.']
  });
  const provider = createOpenAIProvider({ transport });
  const output = await provider.generate(validInput());

  assert.deepEqual(output.claims, [CLAIM]);
  assert.ok(output.text.includes(CLAIM));
});

test('openai provider blocks a draft that omits all approved evidence', async () => {
  const provider = createOpenAIProvider({
    transport: textTransport('Hello, this draft contains no approved facts.')
  });
  await assert.rejects(
    provider.generate(validInput()),
    (error) => error.code === 'FAILED_BRAIN_PROVIDER'
  );
});

test('openai provider blocks empty transport output', async () => {
  const provider = createOpenAIProvider({ transport: textTransport('  ') });
  await assert.rejects(
    provider.generate(validInput()),
    (error) => error.code === 'FAILED_BRAIN_PROVIDER'
  );
});

test('openai provider appends the disclosure phrase when the draft omits it', async () => {
  const provider = createOpenAIProvider({
    transport: textTransport(`Hello,\n\n${CLAIM}\n\nBest, Van`)
  });
  const output = await provider.generate(validInput());
  assert.ok(output.text.includes("Prepared with Path, Van's AI recruiting assistant."));
  assert.equal(output.disclosureIncluded, true);
});

test('default transport requires an OpenAI API key', async () => {
  const provider = createOpenAIProvider({ apiKey: null });
  await assert.rejects(
    provider.generate(validInput()),
    (error) => error.code === 'BLOCKED_NO_OPENAI_KEY'
  );
});

test('default transport maps a non-ok HTTP response to FAILED_BRAIN_PROVIDER', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  try {
    const provider = createOpenAIProvider({ apiKey: 'test-key' });
    await assert.rejects(
      provider.generate(validInput()),
      (error) => error.code === 'FAILED_BRAIN_PROVIDER'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('default transport maps a network failure to FAILED_BRAIN_PROVIDER', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('socket'), { code: 'ETIMEDOUT' }); };
  try {
    const provider = createOpenAIProvider({ apiKey: 'test-key' });
    await assert.rejects(
      provider.generate(validInput()),
      (error) => error.code === 'FAILED_BRAIN_PROVIDER'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('default transport rethrows an unrecognized fetch error unchanged', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  try {
    const provider = createOpenAIProvider({ apiKey: 'test-key' });
    await assert.rejects(
      provider.generate(validInput()),
      (error) => error.code === undefined && error.message === 'fetch failed'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('default transport parses a chat completions response into text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: `Hello,\n\n${CLAIM}` } }]
    })
  });
  try {
    const provider = createOpenAIProvider({ apiKey: 'test-key' });
    const output = await provider.generate(validInput());
    assert.deepEqual(output.claims, [CLAIM]);
    assert.ok(output.text.includes(CLAIM));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createOpenAIProvider rejects invalid model options', () => {
  assert.throws(
    () => createOpenAIProvider({ model: '' }),
    (error) => error.code === 'INVALID_OPENAI_PROVIDER_OPTIONS'
  );
  assert.throws(
    () => createOpenAIProvider({ model: 42 }),
    (error) => error.code === 'INVALID_OPENAI_PROVIDER_OPTIONS'
  );
});

test('gateway-enabled provider runs the model call through the capability gateway and writes receipts', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-openai-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const receiptPath = path.join(rootDir, 'data', 'path-capability-receipts.jsonl');

  const authority = createCapabilityApprovalAuthority();
  const receiptSink = createJsonlReceiptSink(receiptPath);
  const runId = 'run-gateway-test-001';
  const model = DEFAULT_OPENAI_MODEL;
  const objective = 'draft_first_touch';

  const intent = buildCapabilityIntent({
    capabilityId: 'model.invoke',
    actor: 'system',
    metadata: { runId, provider: 'openai', model, objective },
    resources: [{ type: 'model', id: 'openai' }],
    approval: null
  });
  const approval = approveCapability(intent, {
    authority,
    source: 'human',
    approvedBy: 'Van',
    now: APPROVED_AT,
    ttlMs: 24 * 60 * 60 * 1000
  });

  const transport = async ({ apiKey, prompt }) => {
    assert.equal(apiKey, 'test-key');
    assert.ok(prompt.includes(CLAIM));
    return { text: `Hello,\n\n${CLAIM}\n\nBest, Van` };
  };

  const provider = createOpenAIProvider({
    transport,
    apiKey: 'test-key',
    model,
    runId,
    objective,
    approvalAuthority: authority,
    approval,
    receiptSink,
    now: () => NOW
  });

  const output = await provider.generate(validInput());
  assert.equal(output.provider, 'openai');
  assert.deepEqual(output.claims, [CLAIM]);
  assert.ok(output.text.includes(CLAIM));

  const verification = verifyCapabilityReceipts(receiptPath);
  assert.equal(verification.ok, true, verification.code);
  assert.equal(verification.recordCount, 2);
  const lines = fs.readFileSync(receiptPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const attempted = JSON.parse(lines[0]);
  const succeeded = JSON.parse(lines[1]);
  assert.equal(attempted.event, 'capability_attempted');
  assert.equal(attempted.decision, 'ALLOW');
  assert.equal(attempted.capabilityId, 'model.invoke');
  assert.equal(succeeded.event, 'capability_succeeded');
  assert.equal(succeeded.decision, 'ALLOW');
  assert.ok(attempted.approvalSource, 'human');
});

test('gateway is disabled when no approval is supplied; transport runs directly without receipts', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-openai-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const receiptPath = path.join(rootDir, 'data', 'path-capability-receipts.jsonl');

  let transportCalled = false;

  const provider = createOpenAIProvider({
    transport: async () => {
      transportCalled = true;
      return { text: `Hello,\n\n${CLAIM}\n\nBest, Van` };
    },
    apiKey: 'test-key',
    runId: 'run-gateway-test-002',
    objective: 'draft_first_touch',
    now: () => NOW
  });

  const output = await provider.generate(validInput());
  assert.equal(output.provider, 'openai');
  assert.equal(transportCalled, true);
  assert.equal(fs.existsSync(receiptPath), false);
});
