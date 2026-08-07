import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { splitClaims } from '../path-safety/fact-resolver.mjs';

const EXACT_FILES = new Set([
  'cv.md',
  'article-digest.md',
  'config/profile.yml',
  'modes/_profile.md',
  'interview-prep/story-bank.md'
]);
const ONE_LEVEL_INTERVIEW_NOTE = /^interview-prep\/[^/]+\.md$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
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

export function selectEvidence({ rootDir, evidenceRefs, now } = {}) {
  const inspected = readNow(now);
  if (typeof rootDir !== 'string' || rootDir.length === 0 ||
      !Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    throw codedError('BLOCKED_INVALID_EVIDENCE');
  }

  const rootAbsolute = path.resolve(rootDir);
  const rootInfo = safeLstat(rootAbsolute, { bigint: true });
  if (!rootInfo) throw codedError('BLOCKED_SOURCE_UNAVAILABLE');
  if (rootInfo.isSymbolicLink()) throw codedError('BLOCKED_SYMLINK_SOURCE');
  if (!rootInfo.isDirectory()) throw codedError('BLOCKED_SOURCE_UNAVAILABLE');

  let rootReal;
  try {
    rootReal = fs.realpathSync(rootAbsolute);
  } catch {
    throw codedError('BLOCKED_SOURCE_UNAVAILABLE');
  }

  const fileCache = new Map();
  const ids = new Set();
  const validated = evidenceRefs.map((reference) => {
    validateMetadata(reference, inspected, ids);
    const requestedRelative = normalizeRequestedPath(reference.source);
    if (!isAllowlisted(requestedRelative)) throw codedError('BLOCKED_UNAPPROVED_SOURCE');

    const segments = requestedRelative.split('/');
    let candidate = rootAbsolute;
    const pathSnapshots = [{ target: rootAbsolute, info: rootInfo }];
    for (const segment of segments) {
      candidate = path.join(candidate, segment);
      const info = safeLstat(candidate, { bigint: true });
      if (!info) throw codedError('BLOCKED_SOURCE_UNAVAILABLE');
      if (info.isSymbolicLink()) throw codedError('BLOCKED_SYMLINK_SOURCE');
      pathSnapshots.push({ target: candidate, info });
    }

    let sourceReal;
    try {
      sourceReal = fs.realpathSync(candidate);
    } catch {
      throw codedError('BLOCKED_SOURCE_UNAVAILABLE');
    }
    if (!sourceReal.startsWith(`${rootReal}${path.sep}`)) {
      throw codedError('BLOCKED_SOURCE_ESCAPE');
    }
    const resolvedRelative = path.relative(rootReal, sourceReal).split(path.sep).join('/');
    if (!isAllowlisted(resolvedRelative)) throw codedError('BLOCKED_UNAPPROVED_SOURCE');
    assertStablePathSegments(pathSnapshots);

    let source = fileCache.get(sourceReal);
    if (source) {
      validateCachedSource(source, rootReal);
    } else {
      let descriptor;
      try {
        descriptor = fs.openSync(sourceReal, 'r');
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile()) throw new Error('not a file');
        const sourceModifiedAt = fs.fstatSync(descriptor).mtime.toISOString();
        const bytes = fs.readFileSync(descriptor);
        const text = bytes.toString('utf8');
        assertStablePathSegments(pathSnapshots);
        const sourceRealAfter = fs.realpathSync(candidate);
        if (!sourceRealAfter.startsWith(`${rootReal}${path.sep}`)) {
          throw codedError('BLOCKED_SOURCE_ESCAPE');
        }
        const resolvedAfter = path.relative(rootReal, sourceRealAfter).split(path.sep).join('/');
        if (!isAllowlisted(resolvedAfter)) throw codedError('BLOCKED_UNAPPROVED_SOURCE');
        if (sourceRealAfter !== sourceReal || resolvedAfter !== resolvedRelative) {
          throw codedError('BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL');
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        const pathAfter = fs.lstatSync(sourceReal, { bigint: true });
        if (pathAfter.isSymbolicLink() ||
            !sameFileSnapshot(before, after) ||
            !sameFileSnapshot(after, pathAfter)) {
          throw codedError('BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL');
        }
        source = {
          text,
          sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          sourceModifiedAt,
          fileSnapshot: after,
          pathSnapshots,
          candidate,
          sourceReal,
          resolvedRelative
        };
        fileCache.set(sourceReal, source);
      } catch (error) {
        if (BOUNDARY_ERROR_CODES.has(error?.code)) throw error;
        throw codedError('BLOCKED_SOURCE_UNAVAILABLE');
      } finally {
        if (descriptor !== undefined) {
          try {
            fs.closeSync(descriptor);
          } catch {
            // The selection never exposes the descriptor; source validation already completed.
          }
        }
      }
    }

    if (source.sourceSha256 !== reference.expectedSourceSha256) {
      throw codedError('BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL');
    }
    if (!source.text.includes(reference.quote)) throw codedError('BLOCKED_QUOTE_NOT_FOUND');
    if (splitClaims(reference.quote).length !== 1) {
      throw codedError('BLOCKED_NON_ATOMIC_EVIDENCE');
    }

    return {
      id: reference.id,
      factKey: reference.factKey,
      source: resolvedRelative,
      sourceSha256: source.sourceSha256,
      sourceModifiedAt: source.sourceModifiedAt,
      quote: reference.quote,
      normalizedQuote: normalizeQuote(reference.quote),
      authority: 'OWNER_APPROVED_FACT',
      approvedBy: 'Van',
      approvedAt: parseTimestamp(reference.approvedAt).toISOString(),
      approvedTime: parseTimestamp(reference.approvedAt).getTime(),
      factRecordedAt: parseTimestamp(reference.factRecordedAt).toISOString(),
      freshness: normalizeFreshness(reference.freshness),
      supersedesFactIds: [...reference.supersedesFactIds]
    };
  });

  const selectedIds = new Set(validated.map((item) => item.id));
  const supersededEvidenceIds = [];
  const byFactKey = Map.groupBy(validated, (item) => item.factKey);

  for (const group of byFactKey.values()) {
    if (new Set(group.map((item) => item.normalizedQuote)).size <= 1) continue;
    const superseder = group.find((candidate) => group.every((other) =>
      other.normalizedQuote === candidate.normalizedQuote ||
      (candidate.approvedTime > other.approvedTime &&
        candidate.supersedesFactIds.includes(other.id))
    ));
    if (!superseder) throw codedError('UNRESOLVED_CONFLICTING_EVIDENCE');

    for (const item of group) {
      if (item.normalizedQuote !== superseder.normalizedQuote) {
        selectedIds.delete(item.id);
        supersededEvidenceIds.push(item.id);
      }
    }
  }

  for (const source of fileCache.values()) validateCachedSource(source, rootReal);

  return {
    schemaVersion: 'path.evidence-selection.v1',
    inspectedAt: inspected.toISOString(),
    items: validated.filter((item) => selectedIds.has(item.id)).map(toSelectedItem),
    supersededEvidenceIds
  };
}

function validateMetadata(reference, now, ids) {
  if (!isRecord(reference) || Object.keys(reference).some((key) => !EVIDENCE_KEYS.has(key)) ||
      !isNonemptyString(reference.id) ||
      !isNonemptyString(reference.factKey) ||
      typeof reference.source !== 'string' ||
      !isNonemptyString(reference.quote) ||
      reference.sourceType !== 'USER_LAYER_FACT' ||
      reference.authority !== 'OWNER_APPROVED_FACT' ||
      reference.approvedBy !== 'Van' ||
      typeof reference.expectedSourceSha256 !== 'string' ||
      !SHA256.test(reference.expectedSourceSha256) ||
      !Array.isArray(reference.supersedesFactIds) ||
      reference.supersedesFactIds.some((id) => !isNonemptyString(id)) ||
      new Set(reference.supersedesFactIds).size !== reference.supersedesFactIds.length) {
    throw codedError('BLOCKED_INVALID_EVIDENCE');
  }
  if (ids.has(reference.id) || reference.supersedesFactIds.includes(reference.id)) {
    throw codedError('BLOCKED_INVALID_EVIDENCE');
  }
  ids.add(reference.id);

  const approvedAt = parseTimestamp(reference.approvedAt);
  const factRecordedAt = parseTimestamp(reference.factRecordedAt);
  if (!approvedAt || !factRecordedAt || approvedAt > now || factRecordedAt > now ||
      approvedAt < factRecordedAt) {
    throw codedError('BLOCKED_INVALID_EVIDENCE');
  }
  validateFreshness(reference.freshness, now);
}

function validateFreshness(freshness, now) {
  if (!isRecord(freshness)) throw codedError('BLOCKED_INVALID_EVIDENCE');
  if (freshness.mode === 'STATIC') {
    if (!hasExactKeys(freshness, ['mode'])) throw codedError('BLOCKED_INVALID_EVIDENCE');
    return;
  }
  if (freshness.mode !== 'CURRENT' || !hasExactKeys(freshness, ['mode', 'validUntil'])) {
    throw codedError('BLOCKED_INVALID_EVIDENCE');
  }
  const validUntil = parseTimestamp(freshness.validUntil);
  if (!validUntil) throw codedError('BLOCKED_INVALID_EVIDENCE');
  if (validUntil < now) throw codedError('BLOCKED_STALE_EVIDENCE');
}

function normalizeFreshness(freshness) {
  if (freshness.mode === 'STATIC') return { mode: 'STATIC' };
  return { mode: 'CURRENT', validUntil: parseTimestamp(freshness.validUntil).toISOString() };
}

function normalizeRequestedPath(source) {
  if (typeof source !== 'string' || source.length === 0 || source.includes('\0') ||
      path.isAbsolute(source) || /^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('\\\\')) {
    throw codedError('BLOCKED_UNAPPROVED_SOURCE');
  }
  const normalized = source.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw codedError('BLOCKED_UNAPPROVED_SOURCE');
  }
  return normalized;
}

function isAllowlisted(relativePath) {
  return EXACT_FILES.has(relativePath) || ONE_LEVEL_INTERVIEW_NOTE.test(relativePath);
}

function readNow(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const parsed = value instanceof Date ? new Date(value.getTime()) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    throw codedError('BLOCKED_INVALID_EVIDENCE');
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

function safeLstat(target, options) {
  try {
    return fs.lstatSync(target, options);
  } catch {
    return null;
  }
}

const BOUNDARY_ERROR_CODES = new Set([
  'BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL',
  'BLOCKED_SYMLINK_SOURCE',
  'BLOCKED_SOURCE_ESCAPE',
  'BLOCKED_UNAPPROVED_SOURCE'
]);

function assertStablePathSegments(snapshots) {
  const current = snapshots.map(({ target }) => {
    const info = safeLstat(target, { bigint: true });
    if (!info) throw codedError('BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL');
    return info;
  });
  if (current.some((info) => info.isSymbolicLink())) {
    throw codedError('BLOCKED_SYMLINK_SOURCE');
  }
  if (current.some((info, index) => !sameFileSnapshot(snapshots[index].info, info))) {
    throw codedError('BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL');
  }
}

function validateCachedSource(source, rootReal) {
  assertStablePathSegments(source.pathSnapshots);
  let currentReal;
  try {
    currentReal = fs.realpathSync(source.candidate);
  } catch {
    throw codedError('BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL');
  }
  if (!currentReal.startsWith(`${rootReal}${path.sep}`)) {
    throw codedError('BLOCKED_SOURCE_ESCAPE');
  }
  const currentRelative = path.relative(rootReal, currentReal).split(path.sep).join('/');
  if (!isAllowlisted(currentRelative)) throw codedError('BLOCKED_UNAPPROVED_SOURCE');
  if (currentReal !== source.sourceReal || currentRelative !== source.resolvedRelative) {
    throw codedError('BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL');
  }
  const currentFile = safeLstat(source.sourceReal, { bigint: true });
  if (!currentFile) throw codedError('BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL');
  if (currentFile.isSymbolicLink()) throw codedError('BLOCKED_SYMLINK_SOURCE');
  if (!sameFileSnapshot(source.fileSnapshot, currentFile)) {
    throw codedError('BLOCKED_SOURCE_CHANGED_AFTER_APPROVAL');
  }
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function normalizeQuote(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function toSelectedItem(item) {
  return {
    id: item.id,
    factKey: item.factKey,
    source: item.source,
    sourceSha256: item.sourceSha256,
    sourceModifiedAt: item.sourceModifiedAt,
    quote: item.quote,
    authority: item.authority,
    approvedBy: item.approvedBy,
    approvedAt: item.approvedAt,
    factRecordedAt: item.factRecordedAt,
    freshness: item.freshness
  };
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function hasExactKeys(value, expected) {
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
