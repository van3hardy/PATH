import { randomUUID } from 'node:crypto';

import { getCapability } from './capability-catalog.mjs';
import { sha256Hex, stableStringify } from './packet-integrity.mjs';

const INTENT_FIELDS = Object.freeze([
  'capabilityId', 'actor', 'metadata', 'resources', 'approval'
]);
const RESOURCE_FIELDS = Object.freeze(['type', 'id', 'destination']);
const APPROVAL_FIELDS = Object.freeze([
  'approvalId', 'scopeHash', 'source', 'approvedBy', 'issuedAt', 'expiresAt'
]);
const ACTORS = new Set(['agent', 'direct_user', 'system']);
const RESOURCE_TYPES = new Set(['local', 'external', 'model']);
const APPROVAL_SOURCES = new Set(['human', 'direct_cli', 'direct_ui', 'configuration']);
const HEX_64 = /^[a-f0-9]{64}$/;
const APPROVAL_ID = /^[a-f0-9-]{32,64}$/;
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const APPROVAL_AUTHORITIES = new WeakMap();

function codedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, allowed, required = allowed) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);
}

function normalizeJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(normalizeJson));
  if (!isPlainObject(value)) throw codedError('INVALID_CAPABILITY_INTENT');

  const normalized = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (!isNonemptyString(key)) throw codedError('INVALID_CAPABILITY_INTENT');
    Object.defineProperty(normalized, key, {
      value: normalizeJson(value[key]),
      enumerable: true,
      writable: false,
      configurable: false
    });
  }
  return Object.freeze(normalized);
}

function normalizeResource(resource) {
  if (!hasExactFields(resource, RESOURCE_FIELDS, ['type', 'id']) ||
      !RESOURCE_TYPES.has(resource.type) || !isNonemptyString(resource.id)) {
    throw codedError('INVALID_CAPABILITY_INTENT');
  }
  if (resource.type === 'external') {
    if (!isNonemptyString(resource.destination)) throw codedError('INVALID_CAPABILITY_INTENT');
  } else if (Object.hasOwn(resource, 'destination')) {
    throw codedError('INVALID_CAPABILITY_INTENT');
  }
  return Object.freeze({
    type: resource.type,
    id: resource.id.trim(),
    ...(resource.destination === undefined ? {} : { destination: resource.destination.trim() })
  });
}

function normalizeApproval(approval) {
  if (approval === null) return null;
  if (!hasExactFields(approval, APPROVAL_FIELDS) || !APPROVAL_ID.test(approval.approvalId) ||
      !HEX_64.test(approval.scopeHash) ||
      !APPROVAL_SOURCES.has(approval.source) || !isNonemptyString(approval.approvedBy) ||
      typeof approval.issuedAt !== 'string' || typeof approval.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(approval.issuedAt)) ||
      !Number.isFinite(Date.parse(approval.expiresAt)) ||
      Date.parse(approval.expiresAt) <= Date.parse(approval.issuedAt)) {
    throw codedError('INVALID_CAPABILITY_INTENT');
  }
  return Object.freeze({
    approvalId: approval.approvalId,
    scopeHash: approval.scopeHash,
    source: approval.source,
    approvedBy: approval.approvedBy.trim(),
    issuedAt: new Date(approval.issuedAt).toISOString(),
    expiresAt: new Date(approval.expiresAt).toISOString()
  });
}

function normalizeIntent(input) {
  if (!hasExactFields(input, INTENT_FIELDS) || !isNonemptyString(input.capabilityId) ||
      !ACTORS.has(input.actor) || !isPlainObject(input.metadata) ||
      !Array.isArray(input.resources) || input.resources.length === 0) {
    throw codedError('INVALID_CAPABILITY_INTENT');
  }
  const metadata = normalizeJson(input.metadata);
  const resources = Object.freeze(input.resources.map(normalizeResource));
  const approval = normalizeApproval(input.approval);
  return Object.freeze({
    capabilityId: input.capabilityId.trim(),
    actor: input.actor,
    metadata,
    resources,
    approval
  });
}

function scopePayload(intent) {
  return {
    capabilityId: intent.capabilityId,
    actor: intent.actor,
    metadata: intent.metadata,
    resources: intent.resources
  };
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw codedError('INVALID_CAPABILITY_TIME');
  return date;
}

function denial(code, scopeHash, capability = null) {
  return { decision: 'DENY', code, scopeHash, capability };
}

function requirement(code, scopeHash, capability) {
  return { decision: 'REQUIRE_APPROVAL', code, scopeHash, capability };
}

function approvalSourceAllowed(actor, source) {
  if (actor === 'agent') return source === 'human';
  if (actor === 'direct_user') return source === 'direct_cli' || source === 'direct_ui';
  return source === 'configuration' || source === 'human';
}

function hasValidResourceScope(capability, resources) {
  if (!resources.every((resource) => capability.resourceTypes.includes(resource.type))) return false;
  if (capability.effects.some((effect) =>
    effect === 'external_read' || effect === 'external_write')) {
    return resources.some((resource) =>
      resource.type === 'external' && isNonemptyString(resource.destination));
  }
  if (capability.effects.includes('local_write')) {
    return resources.some((resource) => resource.type === 'local');
  }
  if (capability.effects.includes('spend')) {
    return resources.some((resource) => resource.type === 'model');
  }
  return true;
}

function approvalTtl(approval) {
  return Date.parse(approval.expiresAt) - Date.parse(approval.issuedAt);
}

function trustedApprovalRecord(approvalAuthority, approval) {
  const state = APPROVAL_AUTHORITIES.get(approvalAuthority);
  if (!state) return null;
  const record = state.get(approval.approvalId);
  if (!record || record.serialized !== stableStringify(approval)) return null;
  return record;
}

function consumeApproval(approvalAuthority, approval) {
  const record = trustedApprovalRecord(approvalAuthority, approval);
  if (!record || record.consumed) return false;
  record.consumed = true;
  return true;
}

export function createCapabilityApprovalAuthority() {
  const authority = Object.freeze(Object.create(null));
  APPROVAL_AUTHORITIES.set(authority, new Map());
  return authority;
}

export function buildCapabilityIntent(input) {
  return normalizeIntent(input);
}

export function evaluateCapability(input, {
  now = new Date(),
  approvalAuthority
} = {}) {
  let intent;
  try {
    intent = normalizeIntent(input);
  } catch {
    return denial('DENY_INVALID_INTENT', null);
  }

  const scopeHash = sha256Hex(scopePayload(intent));
  const capability = getCapability(intent.capabilityId);
  if (!capability) return denial('DENY_UNKNOWN_CAPABILITY', scopeHash);
  if (capability.policy === 'deny') {
    return denial('DENY_PROHIBITED_CAPABILITY', scopeHash, capability);
  }
  if (!hasValidResourceScope(capability, intent.resources)) {
    return denial('DENY_INVALID_RESOURCE_SCOPE', scopeHash, capability);
  }
  if (capability.policy === 'local_read' &&
      intent.resources.every((resource) => resource.type === 'local')) {
    return { decision: 'ALLOW', code: 'ALLOW_LOCAL_READ', scopeHash, capability };
  }

  if (!intent.approval) return requirement('REQUIRE_HUMAN_APPROVAL', scopeHash, capability);
  const ttlMs = approvalTtl(intent.approval);
  if (ttlMs <= 0 || ttlMs > MAX_APPROVAL_TTL_MS) {
    return requirement('REQUIRE_VALID_APPROVAL_TTL', scopeHash, capability);
  }
  if (intent.approval.scopeHash !== scopeHash) {
    return requirement('REQUIRE_SCOPE_APPROVAL', scopeHash, capability);
  }

  const at = resolveNow(now);
  if (at.getTime() < Date.parse(intent.approval.issuedAt) ||
      at.getTime() >= Date.parse(intent.approval.expiresAt)) {
    return requirement('REQUIRE_FRESH_APPROVAL', scopeHash, capability);
  }
  const trusted = trustedApprovalRecord(approvalAuthority, intent.approval);
  if (!trusted) return requirement('REQUIRE_TRUSTED_APPROVAL', scopeHash, capability);
  if (trusted.consumed) return requirement('REQUIRE_UNUSED_APPROVAL', scopeHash, capability);
  if (!approvalSourceAllowed(intent.actor, intent.approval.source)) {
    return requirement('REQUIRE_HUMAN_APPROVAL', scopeHash, capability);
  }
  return { decision: 'ALLOW', code: 'ALLOW_APPROVED', scopeHash, capability };
}

export function approveCapability(input, {
  authority,
  source,
  approvedBy,
  now = new Date(),
  ttlMs = 5 * 60 * 1000
} = {}) {
  const intent = normalizeIntent(input);
  const authorityState = APPROVAL_AUTHORITIES.get(authority);
  if (!authorityState || !APPROVAL_SOURCES.has(source) || !isNonemptyString(approvedBy) ||
      !Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_APPROVAL_TTL_MS) {
    throw codedError('INVALID_CAPABILITY_APPROVAL');
  }
  const issued = resolveNow(now);
  const approval = Object.freeze({
    approvalId: randomUUID(),
    scopeHash: sha256Hex(scopePayload(intent)),
    source,
    approvedBy: approvedBy.trim(),
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + ttlMs).toISOString()
  });
  authorityState.set(approval.approvalId, {
    serialized: stableStringify(approval),
    consumed: false
  });
  return approval;
}

function receiptFor(intent, evaluation, event, timestamp, outcomeHash = null) {
  return Object.freeze({
    timestamp: timestamp.toISOString(),
    event,
    capabilityId: intent.capabilityId,
    scopeHash: evaluation.scopeHash,
    decision: evaluation.decision,
    code: evaluation.code,
    metadataHash: sha256Hex(stableStringify(intent.metadata)),
    resourcesHash: sha256Hex(stableStringify(intent.resources)),
    approvalSource: intent.approval?.source ?? null,
    outcomeHash
  });
}

export async function executeCapability(input, operation, {
  now = () => new Date(),
  receiptSink,
  approvalAuthority
} = {}) {
  if (typeof operation !== 'function' || typeof receiptSink !== 'function') {
    throw codedError('INVALID_CAPABILITY_EXECUTION');
  }
  const intent = normalizeIntent(input);
  const attemptedAt = resolveNow(now);
  let evaluation = evaluateCapability(intent, { now: attemptedAt, approvalAuthority });
  await receiptSink(receiptFor(intent, evaluation, 'capability_attempted', attemptedAt));

  if (evaluation.decision !== 'ALLOW') {
    const event = evaluation.decision === 'DENY'
      ? 'capability_denied'
      : 'capability_approval_required';
    await receiptSink(receiptFor(intent, evaluation, event, resolveNow(now)));
    return { ...evaluation, executed: false };
  }

  if (evaluation.code === 'ALLOW_APPROVED' &&
      !consumeApproval(approvalAuthority, intent.approval)) {
    evaluation = requirement('REQUIRE_UNUSED_APPROVAL', evaluation.scopeHash, evaluation.capability);
    await receiptSink(receiptFor(
      intent, evaluation, 'capability_approval_required', resolveNow(now)
    ));
    return { ...evaluation, executed: false };
  }

  let result;
  try {
    result = await operation();
  } catch (error) {
    try {
      await receiptSink(receiptFor(
        intent,
        evaluation,
        'capability_failed',
        resolveNow(now),
        sha256Hex({ name: error?.name ?? 'Error', message: error?.message ?? 'unknown' })
      ));
    } catch (receiptError) {
      if (error && (typeof error === 'object' || typeof error === 'function') &&
          Object.isExtensible(error)) {
        Object.defineProperty(error, 'receiptError', {
          value: receiptError,
          enumerable: false,
          configurable: true
        });
      }
    }
    throw error;
  }

  try {
    await receiptSink(receiptFor(
      intent,
      evaluation,
      'capability_succeeded',
      resolveNow(now),
      sha256Hex({ status: 'succeeded' })
    ));
  } catch (error) {
    throw codedError('CAPABILITY_OUTCOME_UNRESOLVED', error);
  }
  return { ...evaluation, executed: true, result };
}
