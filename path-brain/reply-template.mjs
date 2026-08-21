const REQUEST_SCHEMA = 'path.brain.request.v1';
const PROMPT_VERSION = 'path-reply-v1';
const OBJECTIVE = 'draft_email_reply';
const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';
const INPUT_KEYS = [
  'schemaVersion',
  'promptVersion',
  'objective',
  'recipient',
  'opportunity',
  'voiceProfile',
  'disclosurePolicy',
  'replyContext',
  'evidence'
];
const EVIDENCE_KEYS = ['id', 'factKey', 'source', 'quote'];

export const REPLY_TEMPLATE_SEGMENTS = Object.freeze([
  "Best,\nVan\nPrepared with Path, Van's AI recruiting assistant."
]);

export function renderReplyFrame({ recipient, opportunity }) {
  return `Hello ${recipient.name},

Thanks for reaching out about the ${opportunity.role} opportunity at ${opportunity.company}.`;
}

export function renderReplyTemplate(input) {
  if (!hasExactKeys(input, INPUT_KEYS) ||
      input.schemaVersion !== REQUEST_SCHEMA ||
      input.promptVersion !== PROMPT_VERSION ||
      input.objective !== OBJECTIVE ||
      input.voiceProfile !== VOICE_PROFILE ||
      input.disclosurePolicy !== DISCLOSURE_POLICY ||
      !isRecord(input.recipient) ||
      !isNonemptyString(input.recipient.name) ||
      !isRecord(input.opportunity) ||
      !isNonemptyString(input.opportunity.company) ||
      !isNonemptyString(input.opportunity.role) ||
      !isRecord(input.replyContext) ||
      !isNonemptyString(input.replyContext.candidateMessageId) ||
      !isNonemptyString(input.replyContext.originalSubject) ||
      !isNonemptyString(input.replyContext.bodySnippet) ||
      !Array.isArray(input.evidence)) {
    throw codedError('BLOCKED_INVALID_BRAIN_INPUT');
  }
  if (input.evidence.length === 0) throw codedError('BLOCKED_NO_SELECTED_EVIDENCE');

  const claims = input.evidence.map((item) => {
    if (!hasExactKeys(item, EVIDENCE_KEYS) ||
        !isNonemptyString(item.id) ||
        !isNonemptyString(item.factKey) ||
        !isNonemptyString(item.source) ||
        !isNonemptyString(item.quote) ||
        !isAtomic(item.quote)) {
      throw codedError('BLOCKED_INVALID_BRAIN_INPUT');
    }
    return item.quote;
  });

  const text = [
    renderReplyFrame(input),
    claims.join('\n\n'),
    input.replyContext.bodySnippet,
    ...REPLY_TEMPLATE_SEGMENTS
  ].join('\n\n');

  return {
    text,
    claims,
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    disclosureIncluded: true
  };
}

function isAtomic(value) {
  return value
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .length === 1;
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
