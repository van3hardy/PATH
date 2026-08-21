const MAX_REPLY_SNIPPET_CHARS = 1000;
const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';

export { MAX_REPLY_SNIPPET_CHARS };

export function buildReplyRequestFromCandidate(candidate, context, {
  now = () => new Date(),
  idFactory
} = {}) {
  if (!isRecord(candidate) ||
      !nonempty(candidate.message_id) ||
      !nonempty(candidate.from) ||
      !nonempty(candidate.subject) ||
      !nonempty(candidate.body_snippet)) {
    throw codedError('BLOCKED_INVALID_REPLY_CANDIDATE');
  }
  if (!isRecord(context) ||
      !isRecord(context.opportunity) ||
      !nonempty(context.opportunity.company) ||
      !nonempty(context.opportunity.role) ||
      !isRecord(context.requestApproval) ||
      !Array.isArray(context.evidenceRefs) ||
      context.evidenceRefs.length === 0 ||
      !nonempty(context.provider)) {
    throw codedError('BLOCKED_INVALID_REPLY_CONTEXT');
  }

  const createdAt = readNow(now).toISOString();
  const sender = parseSender(candidate.from);
  const inReplyTo = nonempty(candidate.message_id_header)
    ? candidate.message_id_header.trim()
    : optionalTrim(candidate.in_reply_to);
  const references = mergeReferences(candidate.references, inReplyTo);

  return {
    schemaVersion: 'path.recruiter.request.v1',
    runId: typeof idFactory === 'function' ? idFactory() : undefined,
    createdAt,
    objective: 'draft_email_reply',
    action: { type: 'send_email', channel: 'email', touch: 'reply' },
    recipient: sender,
    opportunity: {
      company: context.opportunity.company.trim(),
      role: context.opportunity.role.trim()
    },
    promptVersion: 'path-reply-v1',
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    provider: context.provider,
    requestApproval: structuredClone(context.requestApproval),
    evidenceRefs: structuredClone(context.evidenceRefs),
    replyContext: {
      candidateMessageId: candidate.message_id.trim(),
      originalSubject: candidate.subject.trim(),
      bodySnippet: candidate.body_snippet.trim().slice(0, MAX_REPLY_SNIPPET_CHARS),
      ...(nonempty(candidate.thread_id) ? { threadId: candidate.thread_id.trim() } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {})
    }
  };
}

function parseSender(value) {
  const trimmed = value.trim();
  const bracket = /^(.*?)<([^<>@\s]+@[^<>\s]+)>$/.exec(trimmed);
  if (bracket) {
    const name = bracket[1].trim().replace(/^"|"$/g, '') || bracket[2].trim();
    return { name, address: bracket[2].trim() };
  }
  return { name: trimmed, address: trimmed };
}

function mergeReferences(references, inReplyTo) {
  const parts = [];
  if (nonempty(references)) parts.push(...references.trim().split(/\s+/));
  if (inReplyTo && !parts.includes(inReplyTo)) parts.push(inReplyTo);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function optionalTrim(value) {
  return nonempty(value) ? value.trim() : undefined;
}

function readNow(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const parsed = value instanceof Date ? new Date(value.getTime()) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    throw codedError('BLOCKED_INVALID_REPLY_CONTEXT');
  }
  return parsed;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
