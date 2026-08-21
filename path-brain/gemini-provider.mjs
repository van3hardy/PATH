import {
  buildCapabilityIntent,
  executeCapability
} from '../path-safety/capability-gateway.mjs';
import { normalizeText } from '../path-safety/fact-resolver.mjs';
import { DEFAULT_MODEL } from './provider-ids.mjs';

const OUTPUT_SCHEMA = 'path.brain.output.v1';
const FIRST_TOUCH_OBJECTIVE = 'draft_first_touch';
const REPLY_OBJECTIVE = 'draft_email_reply';
const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';
const DISCLOSURE_PHRASE = "Prepared with Path, Van's AI recruiting assistant.";

export function createGeminiProvider(options = {}) {
  const {
    transport,
    model = DEFAULT_MODEL,
    apiKey,
    runId = null,
    objective = FIRST_TOUCH_OBJECTIVE,
    approvalAuthority = null,
    approval = null,
    receiptSink = null,
    now = () => new Date()
  } = options;

  if (typeof model !== 'string' || model.trim().length === 0) {
    throw codedError('INVALID_GEMINI_PROVIDER_OPTIONS');
  }
  const effectiveTransport = transport ?? defaultTransport;

  const gatewayParams = [approvalAuthority, approval, receiptSink];
  const providedCount = gatewayParams.filter((value) => value !== null).length;
  if (providedCount > 0 && providedCount < 3) {
    throw codedError('INVALID_GEMINI_PROVIDER_OPTIONS');
  }
  const gatewayEnabled = providedCount === 3;

  return Object.freeze({
    async generate(input, { signal } = {}) {
      const text = gatewayEnabled
        ? await gatewayGenerate(input, signal)
        : await effectiveTransport({
            model,
            apiKey: resolveApiKey(apiKey),
            prompt: buildPrompt(input)
          }, { signal });
      const output = applyClaimDiscipline(input, text, model);
      return deepFreeze(output);
    }
  });

  async function gatewayGenerate(input, signal) {
    const prompt = buildPrompt(input);
    const intent = buildCapabilityIntent({
      capabilityId: 'model.invoke',
      actor: 'system',
      metadata: { runId, provider: 'gemini', model, objective },
      resources: [{ type: 'model', id: 'gemini' }],
      approval: null
    });
    const approvedIntent = buildCapabilityIntent({ ...intent, approval });
    const executed = await executeCapability(approvedIntent, () =>
      effectiveTransport({ model, apiKey: resolveApiKey(apiKey), prompt }, { signal }), {
        now,
        receiptSink,
        approvalAuthority
      });
    if (executed.decision !== 'ALLOW') {
      throw codedError('BLOCKED_CAPABILITY_DENIED', executed.code);
    }
    return executed.result;
  }
}

function buildPrompt(input) {
  if (input?.objective === REPLY_OBJECTIVE) return buildReplyPrompt(input);
  return buildFirstTouchPrompt(input);
}

function buildFirstTouchPrompt(input) {
  const recipientName = input?.recipient?.name ?? 'Hiring Manager';
  const role = input?.opportunity?.role ?? '';
  const company = input?.opportunity?.company ?? '';
  const quotes = Array.isArray(input?.evidence)
    ? input.evidence.map((item) => item.quote).filter(isNonemptyString)
    : [];

  return [
    'You are drafting a first-touch outreach email on behalf of Van, an AI recruiting assistant.'.trim(),
    'The message must be respectful, specific, and grounded ONLY in the approved evidence sentences provided below.'.trim(),
    'You MUST include every approved evidence sentence verbatim in the body, unchanged. Do not paraphrase or embellish any of them.'.trim(),
    'Do not invent facts, metrics, projects, or experiences that are not present in the approved evidence.'.trim(),
    '',
    `Recipient name: ${recipientName}`,
    `Opportunity role: ${role}`,
    `Opportunity company: ${company}`,
    '',
    'Approved evidence sentences (include ALL of them verbatim):',
    ...quotes.map((quote) => `- ${quote}`),
    '',
    'Required closing (include verbatim at the end):',
    `Best,\nVan\n${DISCLOSURE_PHRASE}`,
    '',
    'Return ONLY the final email text. Do not include commentary, JSON, or markdown fences.'
  ].join('\n');
}

function buildReplyPrompt(input) {
  const recipientName = input?.recipient?.name ?? 'Recruiter';
  const role = input?.opportunity?.role ?? '';
  const company = input?.opportunity?.company ?? '';
  const originalSubject = input?.replyContext?.originalSubject ?? '';
  const bodySnippet = input?.replyContext?.bodySnippet ?? '';
  const quotes = Array.isArray(input?.evidence)
    ? input.evidence.map((item) => item.quote).filter(isNonemptyString)
    : [];

  return [
    'You are drafting a reply email on behalf of Van, an AI recruiting assistant.'.trim(),
    'The reply must be concise, respectful, and grounded ONLY in the approved evidence sentences provided below.'.trim(),
    'You MUST include every approved evidence sentence verbatim in the body, unchanged. Do not paraphrase or embellish any of them.'.trim(),
    'Do not invent facts, availability, salary expectations, or commitments that are not present in the approved evidence.'.trim(),
    '',
    `Recipient name: ${recipientName}`,
    `Opportunity role: ${role}`,
    `Opportunity company: ${company}`,
    `Original subject: ${originalSubject}`,
    `Original message snippet: ${bodySnippet}`,
    '',
    'Approved evidence sentences (include ALL of them verbatim):',
    ...quotes.map((quote) => `- ${quote}`),
    '',
    'Required closing (include verbatim at the end):',
    `Best,\nVan\n${DISCLOSURE_PHRASE}`,
    '',
    'Return ONLY the final email text. Do not include commentary, JSON, or markdown fences.'
  ].join('\n');
}

function applyClaimDiscipline(input, transportResult, providerModel) {
  const modelText = isRecord(transportResult) && isNonemptyString(transportResult.text)
    ? transportResult.text.trim()
    : isNonemptyString(transportResult) ? transportResult.trim() : '';
  if (modelText.length === 0) throw codedError('FAILED_BRAIN_PROVIDER');

  const normalizedText = normalizeText(modelText);
  const approvedQuotes = Array.isArray(input?.evidence)
    ? input.evidence.map((item) => item.quote).filter(isAtomicQuote)
    : [];

  const declared = isRecord(transportResult) && Array.isArray(transportResult.claims)
    ? transportResult.claims.filter(isAtomicQuote)
    : [];

  const claims = [];
  const seen = new Set();
  for (const claim of [...declared, ...approvedQuotes]) {
    const normalized = normalizeText(claim);
    if (!approvedQuotes.some((quote) => normalizeText(quote) === normalized)) continue;
    if (!normalizedText.includes(normalized)) continue;
    const canonical = approvedQuotes.find((quote) => normalizeText(quote) === normalized);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      claims.push(canonical);
    }
  }
  const approvedCount = new Set(approvedQuotes.map((quote) => normalizeText(quote))).size;
  if (claims.length === 0 || claims.length !== approvedCount) {
    throw codedError('FAILED_BRAIN_PROVIDER');
  }

  let text = modelText;
  if (!normalizedText.includes(normalizeText(DISCLOSURE_PHRASE))) {
    text = `${text}\n\n${DISCLOSURE_PHRASE}`;
  }

  return {
    schemaVersion: OUTPUT_SCHEMA,
    provider: 'gemini',
    model: providerModel,
    promptVersion: input.promptVersion,
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    disclosureIncluded: true,
    claims,
    text
  };
}

async function defaultTransport({ model, apiKey, prompt }, { signal } = {}) {
  if (!isNonemptyString(apiKey)) throw codedError('BLOCKED_NO_GEMINI_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal
    });
  } catch (error) {
    throw wrapProviderError(error);
  }
  if (!response.ok) {
    throw Object.assign(new Error('FAILED_BRAIN_PROVIDER'), {
      code: 'FAILED_BRAIN_PROVIDER',
      cause: `Gemini HTTP ${response.status}`
    });
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw wrapProviderError(error);
  }
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text ?? '')
    .join('') ?? '';
  if (!isNonemptyString(text)) throw codedError('FAILED_BRAIN_PROVIDER');
  return { text };
}

function wrapProviderError(error) {
  if (error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' ||
      error?.code === 'ENOTFOUND' || error?.code === 'ECONNRESET') {
    return Object.assign(new Error('FAILED_BRAIN_PROVIDER'), {
      code: 'FAILED_BRAIN_PROVIDER',
      cause: error
    });
  }
  return error;
}

function resolveApiKey(explicitKey) {
  if (isNonemptyString(explicitKey)) return explicitKey.trim();
  if (isNonemptyString(process.env.GEMINI_API_KEY)) return process.env.GEMINI_API_KEY.trim();
  return null;
}

function isAtomicQuote(value) {
  if (!isNonemptyString(value)) return false;
  return value.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length === 1;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
