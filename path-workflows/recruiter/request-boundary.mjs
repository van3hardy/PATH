import { PROVIDER_IDS } from '../../path-brain/provider-ids.mjs';

const REQUEST_SCHEMA = 'path.recruiter.request.v1';
const FIRST_TOUCH_OBJECTIVE = 'draft_first_touch';
const FIRST_TOUCH_PROMPT_VERSION = 'path-recruiter-v1';
const REPLY_OBJECTIVE = 'draft_email_reply';
const REPLY_PROMPT_VERSION = 'path-reply-v1';
const VOICE_PROFILE = 'path-recruiter-persistent-respectful-v1';
const DISCLOSURE_POLICY = 'always-disclose-ai-assistance-v1';
const MAX_REPLY_SNIPPET_CHARS = 1000;
const RUN_ID = /^run-[a-z0-9-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'runId',
  'createdAt',
  'objective',
  'action',
  'recipient',
  'opportunity',
  'promptVersion',
  'voiceProfile',
  'disclosurePolicy',
  'provider',
  'requestApproval',
  'evidenceRefs',
  'replyContext'
]);

const REPLY_CONTEXT_KEYS = new Set([
  'candidateMessageId',
  'originalSubject',
  'bodySnippet',
  'threadId',
  'inReplyTo',
  'references'
]);

const EVIDENCE_KEYS = new Set([
  'id',
  'factKey',
  'source',
  'sourceType',
  'expectedSourceSha256',
  'quote',
  'authority',
  'approvedBy',
  'approvedAt',
  'factRecordedAt',
  'freshness',
  'supersedesFactIds'
]);

export function validateRecruiterRequest(raw, { now, idFactory } = {}) {
  const details = [];
  const current = readNow(now, details);

  if (!isRecord(raw)) {
    throw invalidRequest(['request']);
  }

  collectUnexpectedKeys(raw, TOP_LEVEL_KEYS, '', details);

  if (raw.schemaVersion !== REQUEST_SCHEMA) details.push('schemaVersion');
  const isFirstTouch = raw.objective === FIRST_TOUCH_OBJECTIVE;
  const isReply = raw.objective === REPLY_OBJECTIVE;
  if (!isFirstTouch && !isReply) details.push('objective');
  if (!hasExactKeys(raw.action, ['type', 'channel', 'touch']) ||
      raw.action.type !== 'send_email' ||
      raw.action.channel !== 'email' ||
      raw.action.touch !== (isReply ? 'reply' : 'first')) {
    details.push('action');
  }
  if (!isRecord(raw.recipient)) {
    details.push('recipient');
  } else {
    collectUnexpectedKeys(raw.recipient, new Set(['name', 'address']), 'recipient.', details);
    if (!isNonemptyString(raw.recipient.name)) details.push('recipient.name');
    if (!isNonemptyString(raw.recipient.address)) details.push('recipient.address');
  }
  if (!isRecord(raw.opportunity)) {
    details.push('opportunity');
  } else {
    collectUnexpectedKeys(raw.opportunity, new Set(['company', 'role']), 'opportunity.', details);
    if (!isNonemptyString(raw.opportunity.company)) details.push('opportunity.company');
    if (!isNonemptyString(raw.opportunity.role)) details.push('opportunity.role');
  }
  const expectedPromptVersion = isReply ? REPLY_PROMPT_VERSION : FIRST_TOUCH_PROMPT_VERSION;
  if (raw.promptVersion !== expectedPromptVersion) details.push('promptVersion');
  if (raw.voiceProfile !== VOICE_PROFILE) details.push('voiceProfile');
  if (raw.disclosurePolicy !== DISCLOSURE_POLICY) details.push('disclosurePolicy');
  if (!PROVIDER_IDS.includes(raw.provider)) details.push('provider');

  const requestApproval = validateRequestApproval(raw.requestApproval, current, details);
  const evidenceRefs = validateEvidenceRefs(raw.evidenceRefs, current, details);
  const replyContext = isReply ? validateReplyContext(raw.replyContext, details) : null;
  if (!isReply && raw.replyContext !== undefined) details.push('replyContext');

  let runId = raw.runId;
  if (runId === undefined) {
    runId = typeof idFactory === 'function' ? idFactory() : undefined;
  }
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) details.push('runId');

  let createdAt = raw.createdAt;
  if (createdAt === undefined && current) createdAt = current.toISOString();
  const created = parseTimestamp(createdAt);
  if (!created || (current && created > current)) details.push('createdAt');

  if (details.length > 0) throw invalidRequest(details);

  return deepFreeze({
    schemaVersion: REQUEST_SCHEMA,
    runId,
    createdAt: created.toISOString(),
    objective: isReply ? REPLY_OBJECTIVE : FIRST_TOUCH_OBJECTIVE,
    action: {
      type: 'send_email',
      channel: 'email',
      touch: isReply ? 'reply' : 'first',
      ...(isReply && replyContext.threadId ? { threadId: replyContext.threadId } : {}),
      ...(isReply && replyContext.inReplyTo ? { inReplyTo: replyContext.inReplyTo } : {}),
      ...(isReply && replyContext.references ? { references: replyContext.references } : {})
    },
    recipient: {
      name: raw.recipient.name.trim(),
      address: raw.recipient.address.trim()
    },
    opportunity: {
      company: raw.opportunity.company.trim(),
      role: raw.opportunity.role.trim()
    },
    promptVersion: expectedPromptVersion,
    voiceProfile: VOICE_PROFILE,
    disclosurePolicy: DISCLOSURE_POLICY,
    provider: raw.provider,
    requestApproval,
    evidenceRefs,
    ...(isReply ? { replyContext } : {})
  });
}

function validateReplyContext(value, details) {
  if (!isRecord(value)) {
    details.push('replyContext');
    return {};
  }
  collectUnexpectedKeys(value, REPLY_CONTEXT_KEYS, 'replyContext.', details);
  if (!isNonemptyString(value.candidateMessageId)) details.push('replyContext.candidateMessageId');
  if (!isNonemptyString(value.originalSubject)) details.push('replyContext.originalSubject');
  if (!isNonemptyString(value.bodySnippet)) details.push('replyContext.bodySnippet');
  if (isNonemptyString(value.bodySnippet) &&
      value.bodySnippet.trim().length > MAX_REPLY_SNIPPET_CHARS) {
    details.push('replyContext.bodySnippet');
  }
  if (Object.hasOwn(value, 'threadId') && !isNonemptyString(value.threadId)) {
    details.push('replyContext.threadId');
  }
  if (Object.hasOwn(value, 'inReplyTo') && !isNonemptyString(value.inReplyTo)) {
    details.push('replyContext.inReplyTo');
  }
  if (Object.hasOwn(value, 'references') && !isNonemptyString(value.references)) {
    details.push('replyContext.references');
  }
  return {
    candidateMessageId: isNonemptyString(value.candidateMessageId)
      ? value.candidateMessageId.trim()
      : value.candidateMessageId,
    originalSubject: isNonemptyString(value.originalSubject)
      ? value.originalSubject.trim()
      : value.originalSubject,
    bodySnippet: isNonemptyString(value.bodySnippet)
      ? value.bodySnippet.trim()
      : value.bodySnippet,
    ...(isNonemptyString(value.threadId) ? { threadId: value.threadId.trim() } : {}),
    ...(isNonemptyString(value.inReplyTo) ? { inReplyTo: value.inReplyTo.trim() } : {}),
    ...(isNonemptyString(value.references) ? { references: value.references.trim() } : {})
  };
}

function validateRequestApproval(value, current, details) {
  if (!isRecord(value)) {
    details.push('requestApproval');
    return null;
  }
  collectUnexpectedKeys(
    value,
    new Set(['principal', 'approvedAt', 'scope']),
    'requestApproval.',
    details
  );
  if (value.principal !== 'Van') details.push('requestApproval.principal');
  if (value.scope !== 'THIS_REQUEST_ONLY') details.push('requestApproval.scope');
  const approvedAt = parseTimestamp(value.approvedAt);
  if (!approvedAt || (current && approvedAt > current)) details.push('requestApproval.approvedAt');
  return {
    principal: 'Van',
    approvedAt: approvedAt?.toISOString(),
    scope: 'THIS_REQUEST_ONLY'
  };
}

function validateEvidenceRefs(value, current, details) {
  if (!Array.isArray(value) || value.length === 0) {
    details.push('evidenceRefs');
    return [];
  }

  const ids = new Set();
  return value.map((reference, index) => {
    const prefix = `evidenceRefs[${index}].`;
    if (!isRecord(reference)) {
      details.push(`evidenceRefs[${index}]`);
      return null;
    }
    collectUnexpectedKeys(reference, EVIDENCE_KEYS, prefix, details);

    if (!isNonemptyString(reference.id)) details.push(`${prefix}id`);
    if (!isNonemptyString(reference.factKey)) details.push(`${prefix}factKey`);
    if (!isNonemptyString(reference.source)) details.push(`${prefix}source`);
    if (reference.sourceType !== 'USER_LAYER_FACT') details.push(`${prefix}sourceType`);
    if (typeof reference.expectedSourceSha256 !== 'string' ||
        !SHA256.test(reference.expectedSourceSha256)) {
      details.push(`${prefix}expectedSourceSha256`);
    }
    if (!isNonemptyString(reference.quote)) details.push(`${prefix}quote`);
    if (reference.authority !== 'OWNER_APPROVED_FACT') details.push(`${prefix}authority`);
    if (reference.approvedBy !== 'Van') details.push(`${prefix}approvedBy`);

    const approvedAt = parseTimestamp(reference.approvedAt);
    const factRecordedAt = parseTimestamp(reference.factRecordedAt);
    if (!approvedAt || (current && approvedAt > current)) details.push(`${prefix}approvedAt`);
    if (!factRecordedAt || (current && factRecordedAt > current)) {
      details.push(`${prefix}factRecordedAt`);
    }
    if (approvedAt && factRecordedAt && approvedAt < factRecordedAt) {
      details.push(`${prefix}approvedAt`);
    }

    const freshness = validateFreshness(reference.freshness, prefix, details);
    if (!Array.isArray(reference.supersedesFactIds) ||
        reference.supersedesFactIds.some((id) => !isNonemptyString(id))) {
      details.push(`${prefix}supersedesFactIds`);
    }
    const supersedesFactIds = Array.isArray(reference.supersedesFactIds)
      ? reference.supersedesFactIds.map((id) => typeof id === 'string' ? id.trim() : id)
      : [];
    if (new Set(supersedesFactIds).size !== supersedesFactIds.length) {
      details.push(`${prefix}supersedesFactIds`);
    }
    if (isNonemptyString(reference.id)) {
      const normalizedId = reference.id.trim();
      if (ids.has(normalizedId)) details.push(`${prefix}id`);
      ids.add(normalizedId);
      if (supersedesFactIds.includes(normalizedId)) details.push(`${prefix}supersedesFactIds`);
    }

    return {
      id: isNonemptyString(reference.id) ? reference.id.trim() : reference.id,
      factKey: isNonemptyString(reference.factKey) ? reference.factKey.trim() : reference.factKey,
      source: isNonemptyString(reference.source) ? reference.source.trim() : reference.source,
      sourceType: 'USER_LAYER_FACT',
      expectedSourceSha256: reference.expectedSourceSha256,
      quote: reference.quote,
      authority: 'OWNER_APPROVED_FACT',
      approvedBy: 'Van',
      approvedAt: approvedAt?.toISOString(),
      factRecordedAt: factRecordedAt?.toISOString(),
      freshness,
      supersedesFactIds
    };
  });
}

function validateFreshness(value, prefix, details) {
  if (!isRecord(value)) {
    details.push(`${prefix}freshness`);
    return null;
  }
  if (value.mode === 'STATIC') {
    if (!hasExactKeys(value, ['mode'])) details.push(`${prefix}freshness`);
    return { mode: 'STATIC' };
  }
  if (value.mode === 'CURRENT') {
    if (!hasExactKeys(value, ['mode', 'validUntil'])) details.push(`${prefix}freshness`);
    const validUntil = parseTimestamp(value.validUntil);
    if (!validUntil) details.push(`${prefix}freshness.validUntil`);
    return { mode: 'CURRENT', validUntil: validUntil?.toISOString() };
  }
  details.push(`${prefix}freshness.mode`);
  return null;
}

function readNow(now, details) {
  const value = typeof now === 'function' ? now() : new Date();
  const parsed = value instanceof Date ? new Date(value.getTime()) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    details.push('now');
    return null;
  }
  return parsed;
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function invalidRequest(details) {
  return Object.assign(new Error('BLOCKED_INVALID_REQUEST'), {
    code: 'BLOCKED_INVALID_REQUEST',
    details: [...new Set(details)]
  });
}

function collectUnexpectedKeys(value, allowed, prefix, details) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) details.push(`${prefix}${key}`);
  }
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

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
