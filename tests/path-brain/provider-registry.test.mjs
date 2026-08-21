import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getProvider,
  PROVIDER_IDS,
  REAL_PROVIDER_IDS
} from '../../path-brain/provider-registry.mjs';

test('registry exposes frozen provider id lists', () => {
  assert.deepEqual(PROVIDER_IDS, ['fake', 'none', 'gemini', 'openai']);
  assert.deepEqual(REAL_PROVIDER_IDS, ['gemini', 'openai']);
  assert.ok(Object.isFrozen(PROVIDER_IDS));
  assert.ok(Object.isFrozen(REAL_PROVIDER_IDS));
});

test('getProvider returns the frozen fake provider by id', async () => {
  const provider = await getProvider('fake');
  assert.equal(typeof provider.generate, 'function');
  assert.ok(Object.isFrozen(provider));
});

test('getProvider returns the no-model provider by id', async () => {
  const provider = await getProvider('none');
  assert.equal(typeof provider.generate, 'function');
  assert.ok(Object.isFrozen(provider));
});

test('getProvider routes gemini to createGeminiProvider with options', async () => {
  const calls = [];
  const transport = async ({ model, apiKey, prompt }) => {
    calls.push({ model, hasKey: Boolean(apiKey), promptLength: prompt.length });
    return { text: 'Van builds agent workflows on Windows 11 with PowerShell.' };
  };
  const provider = await getProvider('gemini', { transport, apiKey: 'test-key', model: 'gemini-test' });
  const output = await provider.generate({
    schemaVersion: 'path.brain.request.v1',
    promptVersion: 'path-recruiter-v1',
    objective: 'draft_first_touch',
    recipient: { name: 'Hiring Manager', address: 'hiring@example.test' },
    opportunity: { company: 'Example Company', role: 'AI Engineer' },
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    evidence: [{
      id: 'fact-1',
      factKey: 'workflow-platform',
      source: 'cv.md',
      quote: 'Van builds agent workflows on Windows 11 with PowerShell.'
    }]
  });

  assert.equal(output.provider, 'gemini');
  assert.equal(output.model, 'gemini-test');
  assert.deepEqual(calls, [{
    model: 'gemini-test',
    hasKey: true,
    promptLength: calls[0].promptLength
  }]);
  assert.ok(calls[0].promptLength > 50);
});

test('getProvider routes openai to createOpenAIProvider with options', async () => {
  const calls = [];
  const transport = async ({ model, apiKey, prompt }) => {
    calls.push({ model, hasKey: Boolean(apiKey), promptLength: prompt.length });
    return { text: 'Van builds agent workflows on Windows 11 with PowerShell.' };
  };
  const provider = await getProvider('openai', { transport, apiKey: 'test-key', model: 'gpt-4o-mini' });
  const output = await provider.generate({
    schemaVersion: 'path.brain.request.v1',
    promptVersion: 'path-recruiter-v1',
    objective: 'draft_first_touch',
    recipient: { name: 'Hiring Manager', address: 'hiring@example.test' },
    opportunity: { company: 'Example Company', role: 'AI Engineer' },
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    evidence: [{
      id: 'fact-1',
      factKey: 'workflow-platform',
      source: 'cv.md',
      quote: 'Van builds agent workflows on Windows 11 with PowerShell.'
    }]
  });

  assert.equal(output.provider, 'openai');
  assert.equal(output.model, 'gpt-4o-mini');
  assert.deepEqual(calls, [{
    model: 'gpt-4o-mini',
    hasKey: true,
    promptLength: calls[0].promptLength
  }]);
  assert.ok(calls[0].promptLength > 50);
});

test('getProvider rejects unknown provider ids with BLOCKED_UNSUPPORTED_PROVIDER', async () => {
  await assert.rejects(
    getProvider('remote'),
    (error) => error.code === 'BLOCKED_UNSUPPORTED_PROVIDER'
  );
  await assert.rejects(
    getProvider(''),
    (error) => error.code === 'BLOCKED_UNSUPPORTED_PROVIDER'
  );
  await assert.rejects(
    getProvider(null),
    (error) => error.code === 'BLOCKED_UNSUPPORTED_PROVIDER'
  );
});