const REQUEST_SCHEMA = 'path.brain.request.v1';
const OUTPUT_SCHEMA = 'path.brain.output.v1';
const FIRST_TOUCH_PROMPT_VERSION = 'path-recruiter-v1';
const FIRST_TOUCH_OBJECTIVE = 'draft_first_touch';
const REPLY_PROMPT_VERSION = 'path-reply-v1';
const REPLY_OBJECTIVE = 'draft_email_reply';
const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';
const OUTPUT_KEYS = [
  'schemaVersion',
  'provider',
  'model',
  'promptVersion',
  'voiceProfile',
  'disclosurePolicy',
  'disclosureIncluded',
  'claims',
  'text'
];

export async function runBrain(
  provider,
  input,
  { timeoutMs = 5_000, claimValidationMode = 'strict' } = {}
) {
  if (!isRecord(provider) || typeof provider.generate !== 'function') {
    throw codedError('FAILED_BRAIN_PROVIDER_INVALID');
  }
  const providerInput = boundedInput(input);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw codedError('BLOCKED_INVALID_BRAIN_INPUT');
  }
  if (!['strict', 'claim-report'].includes(claimValidationMode)) {
    throw codedError('BLOCKED_INVALID_BRAIN_INPUT');
  }

  let timer;
  const controller = new AbortController();
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(codedError('FAILED_BRAIN_TIMEOUT'));
    }, timeoutMs);
  });
  const generated = Promise.resolve()
    .then(() => provider.generate(providerInput, { signal: controller.signal }))
    .catch((error) => {
      if (isStableCodedError(error)) throw error;
      throw Object.assign(new Error('FAILED_BRAIN_PROVIDER'), {
        code: 'FAILED_BRAIN_PROVIDER',
        cause: error
      });
    });

  try {
    const output = await Promise.race([generated, timeout]);
    return deepFreeze(validateOutput(output, providerInput, claimValidationMode));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function boundedInput(input) {
  if (!isRecord(input) ||
      input.schemaVersion !== REQUEST_SCHEMA ||
      !isAllowedObjectivePair(input.promptVersion, input.objective) ||
      input.voiceProfile !== VOICE_PROFILE ||
      input.disclosurePolicy !== DISCLOSURE_POLICY ||
      !isRecord(input.recipient) ||
      !isNonemptyString(input.recipient.name) ||
      !isNonemptyString(input.recipient.address) ||
      !isRecord(input.opportunity) ||
      !isNonemptyString(input.opportunity.company) ||
      !isNonemptyString(input.opportunity.role) ||
      !Array.isArray(input.evidence)) {
    throw codedError('BLOCKED_INVALID_BRAIN_INPUT');
  }

  const evidence = input.evidence.map((item) => {
    if (!isRecord(item) ||
        !isNonemptyString(item.id) ||
        !isNonemptyString(item.factKey) ||
        !isNonemptyString(item.source) ||
        !isNonemptyString(item.quote)) {
      throw codedError('BLOCKED_INVALID_BRAIN_INPUT');
    }
    return {
      id: item.id,
      factKey: item.factKey,
      source: item.source,
      quote: item.quote
    };
  });

  return {
    schemaVersion: REQUEST_SCHEMA,
    promptVersion: input.promptVersion,
    objective: input.objective,
    recipient: { name: input.recipient.name, address: input.recipient.address },
    opportunity: { company: input.opportunity.company, role: input.opportunity.role },
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    ...(input.objective === REPLY_OBJECTIVE ? { replyContext: boundedReplyContext(input.replyContext) } : {}),
    evidence
  };
}

function isAllowedObjectivePair(promptVersion, objective) {
  return promptVersion === FIRST_TOUCH_PROMPT_VERSION && objective === FIRST_TOUCH_OBJECTIVE ||
    promptVersion === REPLY_PROMPT_VERSION && objective === REPLY_OBJECTIVE;
}

function boundedReplyContext(value) {
  if (!isRecord(value) ||
      !isNonemptyString(value.candidateMessageId) ||
      !isNonemptyString(value.originalSubject) ||
      !isNonemptyString(value.bodySnippet)) {
    throw codedError('BLOCKED_INVALID_BRAIN_INPUT');
  }
  return {
    candidateMessageId: value.candidateMessageId,
    originalSubject: value.originalSubject,
    bodySnippet: value.bodySnippet,
    ...(isNonemptyString(value.threadId) ? { threadId: value.threadId } : {}),
    ...(isNonemptyString(value.inReplyTo) ? { inReplyTo: value.inReplyTo } : {}),
    ...(isNonemptyString(value.references) ? { references: value.references } : {})
  };
}

function validateOutput(output, input, claimValidationMode) {
  if (!hasExactKeys(output, OUTPUT_KEYS) ||
      output.schemaVersion !== OUTPUT_SCHEMA ||
      !isNonemptyString(output.provider) ||
      !isNonemptyString(output.model) ||
      output.promptVersion !== input.promptVersion ||
      output.voiceProfile !== input.voiceProfile ||
      output.disclosurePolicy !== input.disclosurePolicy ||
      output.disclosureIncluded !== true ||
      !Array.isArray(output.claims) ||
      output.claims.length === 0 ||
      !isNonemptyString(output.text)) {
    throw codedError('FAILED_BRAIN_OUTPUT_INVALID');
  }

  for (const claim of output.claims) {
    const matchingQuotes = input.evidence.filter((item) => item.quote === claim);
    if (!isNonemptyString(claim) || !isAtomic(claim) ||
        claimValidationMode === 'strict' && matchingQuotes.length !== 1) {
      throw codedError('FAILED_BRAIN_OUTPUT_INVALID');
    }
  }

  return {
    schemaVersion: OUTPUT_SCHEMA,
    provider: output.provider,
    model: output.model,
    promptVersion: output.promptVersion,
    voiceProfile: output.voiceProfile,
    disclosurePolicy: output.disclosurePolicy,
    disclosureIncluded: true,
    claims: [...output.claims],
    text: output.text
  };
}

function isAtomic(value) {
  return value
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .length === 1;
}

function isStableCodedError(error) {
  return error instanceof Error && isNonemptyString(error.code);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
