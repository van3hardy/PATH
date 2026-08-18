import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGeminiProvider } from '../../path-brain/gemini-provider.mjs';
import { DEFAULT_MODEL } from '../../path-brain/provider-ids.mjs';
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

function textTransport(text) {
  return async () => ({ text });
}

test('createGeminiProvider returns a frozen provider with generate', () => {
  const provider = createGeminiProvider({ transport: textTransport(CLAIM) });
  assert.equal(typeof provider.generate, 'function');
  assert.ok(Object.isFrozen(provider));
});

test('gemini provider returns exact contract-shaped output for a verbatim evidence draft', async () => {
  const text = `Hello Hiring Manager,

I'm reaching out on Van's behalf about the AI Engineer opportunity at Example Company.

${CLAIM}

If this background may be relevant, would you be open to a conversation?

Best,
Van
Prepared with Path, Van's AI recruiting assistant.`;
  const provider = createGeminiProvider({ transport: textTransport(text) });
  const output = await provider.generate(validInput());

  assert.deepEqual(output, {
    schemaVersion: 'path.brain.output.v1',
    provider: 'gemini',
    model: DEFAULT_MODEL,
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

test('gemini provider honors an explicit model override', async () => {
  const provider = createGeminiProvider({
    transport: textTransport(CLAIM),
    model: 'gemini-custom'
  });
  const output = await provider.generate(validInput());
  assert.equal(output.model, 'gemini-custom');
});

test('gemini provider uses declared claims filtered to approved quotes present in text', async () => {
  const transport = async () => ({
    text: `Hello,

${CLAIM}

Best, Van Prepared with Path, Van's AI recruiting assistant.`,
    claims: [CLAIM, 'Van built an open-source framework.']
  });
  const provider = createGeminiProvider({ transport });
  const output = await provider.generate(validInput());

  assert.deepEqual(output.claims, [CLAIM]);
  assert.ok(output.text.includes(CLAIM));
});

test('gemini provider blocks a draft that omits all approved evidence', async () => {
  const provider = createGeminiProvider({
    transport: textTransport('Hello, this draft contains no approved facts.')
  });
  await assert.rejects(
    provider.generate(validInput()),
    (error) => error.code === 'FAILED_BRAIN_PROVIDER'
  );
});

test('gemini provider blocks empty transport output', async () => {
  const provider = createGeminiProvider({ transport: textTransport('  ') });
  await assert.rejects(
    provider.generate(validInput()),
    (error) => error.code === 'FAILED_BRAIN_PROVIDER'
  );
});

test('gemini provider appends the disclosure phrase when the draft omits it', async () => {
  const provider = createGeminiProvider({
    transport: textTransport(`Hello,\n\n${CLAIM}\n\nBest, Van`)
  });
  const output = await provider.generate(validInput());
  assert.ok(output.text.includes("Prepared with Path, Van's AI recruiting assistant."));
  assert.equal(output.disclosureIncluded, true);
});

test('default transport requires a Gemini API key', async () => {
  const provider = createGeminiProvider({ apiKey: null });
  await assert.rejects(
    provider.generate(validInput()),
    (error) => error.code === 'BLOCKED_NO_GEMINI_KEY'
  );
});

test('default transport maps a non-ok HTTP response to FAILED_BRAIN_PROVIDER', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  try {
    const provider = createGeminiProvider({ apiKey: 'test-key' });
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
    const provider = createGeminiProvider({ apiKey: 'test-key' });
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
    const provider = createGeminiProvider({ apiKey: 'test-key' });
    await assert.rejects(
      provider.generate(validInput()),
      (error) => error.code === undefined && error.message === 'fetch failed'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('default transport parses a candidates response into text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: `Hello,\n\n${CLAIM}` }] } }]
    })
  });
  try {
    const provider = createGeminiProvider({ apiKey: 'test-key' });
    const output = await provider.generate(validInput());
    assert.deepEqual(output.claims, [CLAIM]);
    assert.ok(output.text.includes(CLAIM));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createGeminiProvider rejects invalid model options', () => {
  assert.throws(
    () => createGeminiProvider({ model: '' }),
    (error) => error.code === 'INVALID_GEMINI_PROVIDER_OPTIONS'
  );
  assert.throws(
    () => createGeminiProvider({ model: 42 }),
    (error) => error.code === 'INVALID_GEMINI_PROVIDER_OPTIONS'
  );
});

test('gateway-enabled provider runs the model call through the capability gateway and writes receipts', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-gemini-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const receiptPath = path.join(rootDir, 'data', 'path-capability-receipts.jsonl');

  const authority = createCapabilityApprovalAuthority();
  const receiptSink = createJsonlReceiptSink(receiptPath);
  const runId = 'run-gateway-test-001';
  const model = DEFAULT_MODEL;
  const objective = 'draft_first_touch';

  const intent = buildCapabilityIntent({
    capabilityId: 'model.invoke',
    actor: 'system',
    metadata: { runId, provider: 'gemini', model, objective },
    resources: [{ type: 'model', id: 'gemini' }],
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

  const provider = createGeminiProvider({
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
  assert.equal(output.provider, 'gemini');
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-gemini-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const receiptPath = path.join(rootDir, 'data', 'path-capability-receipts.jsonl');

  const authority = createCapabilityApprovalAuthority();
  const receiptSink = createJsonlReceiptSink(receiptPath);
  let transportCalled = false;

  const provider = createGeminiProvider({
    transport: async () => {
      transportCalled = true;
      return { text: `Hello,\n\n${CLAIM}\n\nBest, Van` };
    },
    apiKey: 'test-key',
    runId: 'run-gateway-test-002',
    objective: 'draft_first_touch',
    approvalAuthority: authority,
    approval: null,
    receiptSink,
    now: () => NOW
  });

  const output = await provider.generate(validInput());
  assert.equal(output.provider, 'gemini');
  assert.equal(transportCalled, true);
  assert.equal(fs.existsSync(receiptPath), false);
});