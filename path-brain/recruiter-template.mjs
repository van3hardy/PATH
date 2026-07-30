const REQUEST_SCHEMA = 'path.brain.request.v1';
const PROMPT_VERSION = 'path-recruiter-v1';
const OBJECTIVE = 'draft_first_touch';
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
  'evidence'
];
const EVIDENCE_KEYS = ['id', 'factKey', 'source', 'quote'];

export function renderRecruiterTemplate(input) {
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

  const text = `Hello ${input.recipient.name},

I'm reaching out on Van's behalf about the ${input.opportunity.role} opportunity at ${input.opportunity.company}.

${claims.join('\n\n')}

If this background may be relevant, would you be open to a conversation?

Best,
Van
Prepared with Path, Van's AI recruiting assistant.`;

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
