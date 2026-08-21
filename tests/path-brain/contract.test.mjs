import assert from 'node:assert/strict';
import test from 'node:test';

import { runBrain } from '../../path-brain/contract.mjs';

const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';
const CLAIM = 'Van builds agent workflows on Windows 11 with PowerShell.';

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

function validOutput(overrides = {}) {
  return {
    schemaVersion: 'path.brain.output.v1',
    provider: 'fake',
    model: 'deterministic-recruiter-template-v1',
    promptVersion: 'path-recruiter-v1',
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    disclosureIncluded: true,
    claims: [CLAIM],
    text: 'Complete deterministic recruiter draft.',
    ...overrides
  };
}

test('runBrain accepts the bounded reply objective and forwards reply context only', async () => {
  const input = validReplyInput();
  input.replyContext.rawBody = 'must-not-cross-boundary';
  input.replyContext.extra = 'must-not-cross-boundary';
  input.replyContext.threadId = 'thread-123';
  input.replyContext.references = '<root@example.test> <original@example.test>';
  input.stylePrompt = 'be casual';

  let received;
  const provider = {
    async generate(value) {
      received = value;
      return validOutput({
        promptVersion: 'path-reply-v1',
        text: `Thanks for reaching out. ${CLAIM}`
      });
    }
  };

  const result = await runBrain(provider, input, { timeoutMs: 100 });

  assert.deepEqual(received, {
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
  });
  assert.equal(result.promptVersion, 'path-reply-v1');
  assert.deepEqual(result.claims, [CLAIM]);
});

test('runBrain rejects mismatched prompt version and reply objective pairs', async () => {
  const invalidCases = [
    () => { const input = validReplyInput(); input.promptVersion = 'path-recruiter-v1'; return input; },
    () => { const input = validInput(); input.objective = 'draft_email_reply'; return input; },
    () => { const input = validReplyInput(); delete input.replyContext; return input; },
    () => { const input = validReplyInput(); input.replyContext.bodySnippet = ' '; return input; }
  ];
  for (const createInput of invalidCases) {
    let calls = 0;
    await assert.rejects(
      runBrain({ generate() { calls += 1; } }, createInput(), { timeoutMs: 100 }),
      (error) => error.code === 'BLOCKED_INVALID_BRAIN_INPUT'
    );
    assert.equal(calls, 0);
  }
});

test('runBrain sends one new bounded request and returns a deep-frozen copy', async () => {
  const input = validInput();
  input.recipient.approval = 'must-not-cross-boundary';
  input.opportunity.url = 'https://must-not-cross-boundary.test';
  input.evidence[0].sourceSha256 = 'a'.repeat(64);
  input.evidence[0].approval = { approvedBy: 'Van' };
  input.evidence[0].rawSourceText = 'must-not-cross-boundary';
  input.tools = [{ name: 'send' }];
  input.stylePrompt = 'be aggressive';
  input.rootDir = 'C:\\outside';

  const providerOutput = validOutput();
  let calls = 0;
  let received;
  const provider = {
    async generate(value) {
      calls += 1;
      received = value;
      return providerOutput;
    }
  };

  const result = await runBrain(provider, input, { timeoutMs: 100 });

  assert.equal(calls, 1);
  assert.deepEqual(received, validInput());
  assert.notStrictEqual(received, input);
  assert.notStrictEqual(received.recipient, input.recipient);
  assert.notStrictEqual(received.opportunity, input.opportunity);
  assert.notStrictEqual(received.evidence, input.evidence);
  assert.notStrictEqual(received.evidence[0], input.evidence[0]);
  assert.deepEqual(result, validOutput());
  assert.notStrictEqual(result, providerOutput);
  assert.notStrictEqual(result.claims, providerOutput.claims);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.claims), true);

  providerOutput.claims[0] = 'Provider mutation.';
  providerOutput.text = 'Provider mutation.';
  input.evidence[0].quote = 'Caller mutation.';
  assert.equal(result.claims[0], CLAIM);
  assert.equal(result.text, 'Complete deterministic recruiter draft.');
});

test('runBrain rejects an invalid provider before any call', async () => {
  for (const provider of [null, {}, { generate: 'not-a-function' }]) {
    await assert.rejects(
      runBrain(provider, validInput(), { timeoutMs: 100 }),
      (error) => error.code === 'FAILED_BRAIN_PROVIDER_INVALID'
    );
  }
});

test('runBrain rejects invalid request versions and fixed policy values', async () => {
  const invalidCases = [
    ['schemaVersion', 'path.brain.request.v2'],
    ['promptVersion', 'path-recruiter-v2'],
    ['objective', 'mass_outreach'],
    ['voiceProfile', 'unknown-voice'],
    ['disclosurePolicy', 'sometimes-disclose']
  ];
  for (const [key, value] of invalidCases) {
    const input = validInput();
    input[key] = value;
    let calls = 0;
    await assert.rejects(
      runBrain({ generate() { calls += 1; } }, input, { timeoutMs: 100 }),
      (error) => error.code === 'BLOCKED_INVALID_BRAIN_INPUT'
    );
    assert.equal(calls, 0);
  }
});

test('runBrain rejects a wrong output schema', async () => {
  await assert.rejects(
    runBrain({ async generate() { return validOutput({ schemaVersion: 'path.brain.output.v2' }); } }, validInput()),
    (error) => error.code === 'FAILED_BRAIN_OUTPUT_INVALID'
  );
});

test('runBrain rejects a wrong output prompt version', async () => {
  await assert.rejects(
    runBrain({ async generate() { return validOutput({ promptVersion: 'path-recruiter-v2' }); } }, validInput()),
    (error) => error.code === 'FAILED_BRAIN_OUTPUT_INVALID'
  );
});

test('runBrain rejects empty output text', async () => {
  await assert.rejects(
    runBrain({ async generate() { return validOutput({ text: ' ' }); } }, validInput()),
    (error) => error.code === 'FAILED_BRAIN_OUTPUT_INVALID'
  );
});

test('runBrain rejects extra output fields', async () => {
  await assert.rejects(
    runBrain({ async generate() { return validOutput({ toolCalls: [] }); } }, validInput()),
    (error) => error.code === 'FAILED_BRAIN_OUTPUT_INVALID'
  );
});

test('runBrain rejects malformed locked output fields', async () => {
  const invalidCases = [
    { provider: '' },
    { model: ' ' },
    { voiceProfile: 'unknown-voice' },
    { disclosurePolicy: 'sometimes-disclose' },
    { disclosureIncluded: false },
    { claims: [] }
  ];
  for (const override of invalidCases) {
    await assert.rejects(
      runBrain({ async generate() { return validOutput(override); } }, validInput()),
      (error) => error.code === 'FAILED_BRAIN_OUTPUT_INVALID'
    );
  }
});

test('runBrain rejects a declared claim absent from selected evidence', async () => {
  await assert.rejects(
    runBrain({
      async generate() {
        return validOutput({ claims: ['Van invented an unsupported claim.'] });
      }
    }, validInput()),
    (error) => error.code === 'FAILED_BRAIN_OUTPUT_INVALID'
  );
});

test('runBrain remains selected-evidence strict by default after claim-report mode is added', async () => {
  let calls = 0;
  await assert.rejects(
    runBrain({
      async generate() {
        calls += 1;
        return validOutput({ claims: ['Van invented an unsupported claim.'] });
      }
    }, validInput()),
    (error) => error.code === 'FAILED_BRAIN_OUTPUT_INVALID'
  );
  assert.equal(calls, 1);
});

test('explicit claim-report mode returns a frozen structurally valid atomic unsupported claim', async () => {
  const unsupportedClaim = 'Van invented an unsupported claim.';
  let calls = 0;
  const result = await runBrain({
    async generate() {
      calls += 1;
      return validOutput({ claims: [unsupportedClaim] });
    }
  }, validInput(), { claimValidationMode: 'claim-report' });

  assert.equal(calls, 1);
  assert.deepEqual(result, validOutput({ claims: [unsupportedClaim] }));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.claims), true);
});

test('claim-report mode still rejects malformed and non-atomic provider output', async () => {
  const invalidOutputs = [
    validOutput({ claims: ['Van invented one claim. Van invented another claim.'] }),
    validOutput({ disclosureIncluded: false }),
    validOutput({ text: ' ' }),
    validOutput({ toolCalls: [] })
  ];

  for (const output of invalidOutputs) {
    await assert.rejects(
      runBrain({ async generate() { return output; } }, validInput(), {
        claimValidationMode: 'claim-report'
      }),
      (error) => error.code === 'FAILED_BRAIN_OUTPUT_INVALID'
    );
  }
});

test('runBrain rejects non-atomic declared claims', async () => {
  const input = validInput();
  const compound = 'Van builds agents. Van runs production systems.';
  input.evidence[0].quote = compound;
  await assert.rejects(
    runBrain({ async generate() { return validOutput({ claims: [compound] }); } }, input),
    (error) => error.code === 'FAILED_BRAIN_OUTPUT_INVALID'
  );
});

test('runBrain requires every claim to match exactly one selected quote', async () => {
  const input = validInput();
  input.evidence.push({ ...input.evidence[0], id: 'fact-2', factKey: 'duplicate-fact' });
  await assert.rejects(
    runBrain({ async generate() { return validOutput(); } }, input),
    (error) => error.code === 'FAILED_BRAIN_OUTPUT_INVALID'
  );
});

test('runBrain times out a never-resolving provider without a fallback call', async () => {
  let calls = 0;
  const provider = {
    generate() {
      calls += 1;
      return new Promise(() => {});
    }
  };
  await assert.rejects(
    runBrain(provider, validInput(), { timeoutMs: 10 }),
    (error) => error.code === 'FAILED_BRAIN_TIMEOUT'
  );
  assert.equal(calls, 1);
});

test('runBrain creates one timer and clears it in finally after success', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timerToken = { timer: 'brain-timeout' };
  const delays = [];
  const cleared = [];
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(typeof callback, 'function');
    delays.push(delay);
    return timerToken;
  };
  globalThis.clearTimeout = (token) => cleared.push(token);
  try {
    const result = await runBrain(
      { async generate() { return validOutput(); } },
      validInput(),
      { timeoutMs: 321 }
    );
    assert.equal(result.provider, 'fake');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.deepEqual(delays, [321]);
  assert.deepEqual(cleared, [timerToken]);
});

test('runBrain clears its one timer exactly once after FAILED_BRAIN_TIMEOUT', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timerToken = { timer: 'timeout-path' };
  const created = [];
  const cleared = [];
  let providerCalls = 0;
  globalThis.setTimeout = (callback, delay) => {
    created.push({ callback, delay, token: timerToken });
    queueMicrotask(callback);
    return timerToken;
  };
  globalThis.clearTimeout = (token) => cleared.push(token);
  try {
    await assert.rejects(
      runBrain({
        generate() {
          providerCalls += 1;
          return new Promise(() => {});
        }
      }, validInput(), { timeoutMs: 654 }),
      (error) => error.code === 'FAILED_BRAIN_TIMEOUT'
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(providerCalls, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].delay, 654);
  assert.equal(typeof created[0].callback, 'function');
  assert.strictEqual(created[0].token, timerToken);
  assert.deepEqual(cleared, [timerToken]);
});

test('runBrain clears the same timer exactly once after coded and uncoded provider errors', async () => {
  const cases = [
    {
      name: 'stable coded error',
      providerError: Object.assign(new Error('BLOCKED_PROVIDER_REFUSAL'), {
        code: 'BLOCKED_PROVIDER_REFUSAL'
      }),
      matches(error, providerError) {
        return error === providerError;
      }
    },
    {
      name: 'uncoded error',
      providerError: new Error('provider-specific sensitive detail'),
      matches(error, providerError) {
        return error.code === 'FAILED_BRAIN_PROVIDER' && error.cause === providerError;
      }
    }
  ];

  for (const errorCase of cases) {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timerToken = { timer: errorCase.name };
    const created = [];
    const cleared = [];
    let providerCalls = 0;
    globalThis.setTimeout = (callback, delay) => {
      created.push({ callback, delay, token: timerToken });
      return timerToken;
    };
    globalThis.clearTimeout = (token) => cleared.push(token);
    try {
      await assert.rejects(
        runBrain({
          async generate() {
            providerCalls += 1;
            throw errorCase.providerError;
          }
        }, validInput(), { timeoutMs: 987 }),
        (error) => errorCase.matches(error, errorCase.providerError)
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
    assert.equal(providerCalls, 1, errorCase.name);
    assert.equal(created.length, 1, errorCase.name);
    assert.equal(created[0].delay, 987, errorCase.name);
    assert.equal(typeof created[0].callback, 'function', errorCase.name);
    assert.strictEqual(created[0].token, timerToken, errorCase.name);
    assert.deepEqual(cleared, [timerToken], errorCase.name);
  }
});

test('runBrain propagates a stable coded provider error unchanged', async () => {
  const providerError = Object.assign(new Error('BLOCKED_PROVIDER_REFUSAL'), {
    code: 'BLOCKED_PROVIDER_REFUSAL'
  });
  await assert.rejects(
    runBrain({ async generate() { throw providerError; } }, validInput()),
    (error) => error === providerError
  );
});

test('runBrain classifies an uncoded provider error', async () => {
  const providerError = new Error('provider-specific sensitive detail');
  await assert.rejects(
    runBrain({ async generate() { throw providerError; } }, validInput()),
    (error) => error.code === 'FAILED_BRAIN_PROVIDER' && error.cause === providerError
  );
});

test('runBrain handles a late provider rejection after timeout', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      runBrain({
        generate() {
          return new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error('late rejection')), 25);
          });
        }
      }, validInput(), { timeoutMs: 5 }),
      (error) => error.code === 'FAILED_BRAIN_TIMEOUT'
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('runBrain ignores a controlled late resolution after returning FAILED_BRAIN_TIMEOUT', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  const forbiddenCalls = { fallback: 0, output: 0, write: 0 };
  let providerCalls = 0;
  let resolveProvider;
  let lateResolutionOccurred = false;
  const provider = {
    generate() {
      providerCalls += 1;
      return new Promise((resolve) => {
        resolveProvider = () => {
          lateResolutionOccurred = true;
          resolve(validOutput());
        };
      });
    },
    fallback() {
      forbiddenCalls.fallback += 1;
    },
    onOutput() {
      forbiddenCalls.output += 1;
    },
    write() {
      forbiddenCalls.write += 1;
    }
  };
  const input = validInput();
  input.onOutput = () => { forbiddenCalls.output += 1; };
  input.write = () => { forbiddenCalls.write += 1; };

  process.on('unhandledRejection', onUnhandled);
  try {
    let timeoutReturned = false;
    await assert.rejects(
      runBrain(provider, input, { timeoutMs: 5 }),
      (error) => {
        timeoutReturned = error.code === 'FAILED_BRAIN_TIMEOUT';
        return timeoutReturned;
      }
    );
    assert.equal(timeoutReturned, true);
    assert.equal(providerCalls, 1);
    assert.equal(lateResolutionOccurred, false);
    assert.equal(typeof resolveProvider, 'function');
    assert.deepEqual(forbiddenCalls, { fallback: 0, output: 0, write: 0 });

    resolveProvider();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(lateResolutionOccurred, true);
    assert.equal(providerCalls, 1);
    assert.deepEqual(forbiddenCalls, { fallback: 0, output: 0, write: 0 });
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});
