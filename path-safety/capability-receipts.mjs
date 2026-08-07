import fs from 'node:fs';
import path from 'node:path';

import { sha256Hex, stableStringify } from './packet-integrity.mjs';

const HEX_64 = /^[a-f0-9]{64}$/;
const RECEIPT_FIELDS = Object.freeze([
  'timestamp', 'event', 'capabilityId', 'scopeHash', 'decision', 'code',
  'metadataHash', 'resourcesHash', 'approvalSource', 'outcomeHash'
]);
const STORED_FIELDS = Object.freeze([
  'schemaVersion', 'sequence', ...RECEIPT_FIELDS, 'previousHash', 'recordHash'
]);
const EVENTS = new Set([
  'capability_attempted', 'capability_denied', 'capability_approval_required',
  'capability_succeeded', 'capability_failed'
]);
const DECISIONS = new Set(['ALLOW', 'REQUIRE_APPROVAL', 'DENY']);
const APPROVAL_SOURCES = new Set(['human', 'direct_cli', 'direct_ui', 'configuration']);
const LOCK_RETRY_COUNT = 100;
const LOCK_RETRY_MS = 10;

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

function hasExactFields(value, fields) {
  return isPlainObject(value) && Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value);
}

function waitSync(milliseconds) {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waiter, 0, 0, milliseconds);
}

function acquireLock(lockPath) {
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw codedError('FAILED_CAPABILITY_RECEIPT_LOCK', error);
      }
      if (attempt + 1 < LOCK_RETRY_COUNT) waitSync(LOCK_RETRY_MS);
    }
  }
  throw codedError('FAILED_CAPABILITY_RECEIPT_LOCKED');
}

function validReceiptFacts(receipt) {
  return hasExactFields(receipt, RECEIPT_FIELDS) &&
    typeof receipt.timestamp === 'string' && Number.isFinite(Date.parse(receipt.timestamp)) &&
    EVENTS.has(receipt.event) && isNonemptyString(receipt.capabilityId) &&
    HEX_64.test(receipt.scopeHash) && DECISIONS.has(receipt.decision) &&
    isNonemptyString(receipt.code) && HEX_64.test(receipt.metadataHash) &&
    HEX_64.test(receipt.resourcesHash) &&
    (receipt.approvalSource === null || APPROVAL_SOURCES.has(receipt.approvalSource)) &&
    (receipt.outcomeHash === null || HEX_64.test(receipt.outcomeHash));
}

function validStoredReceipt(receipt, index) {
  return hasExactFields(receipt, STORED_FIELDS) && receipt.schemaVersion === 'path.capability-receipt.v1' &&
    receipt.sequence === index + 1 && validReceiptFacts(Object.fromEntries(
      RECEIPT_FIELDS.map((field) => [field, receipt[field]])
    )) &&
    (receipt.previousHash === 'GENESIS' || HEX_64.test(receipt.previousHash)) &&
    HEX_64.test(receipt.recordHash);
}

function loadEntries(receiptPath) {
  if (!fs.existsSync(receiptPath)) return { ok: true, entries: [] };
  let lines;
  try {
    lines = fs.readFileSync(receiptPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return { ok: false, code: 'FAILED_CAPABILITY_RECEIPT_READ', recordIndex: 0 };
  }
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      entries.push(JSON.parse(lines[index]));
    } catch {
      return { ok: false, code: 'FAILED_CAPABILITY_RECEIPT_MALFORMED', recordIndex: index };
    }
  }
  return { ok: true, entries };
}

export function verifyCapabilityReceipts(receiptPath) {
  const loaded = loadEntries(receiptPath);
  if (!loaded.ok) return loaded;

  let previousHash = 'GENESIS';
  for (let index = 0; index < loaded.entries.length; index += 1) {
    const entry = loaded.entries[index];
    if (isPlainObject(entry) && HEX_64.test(entry.recordHash)) {
      const { recordHash, ...withoutHash } = entry;
      if (recordHash !== sha256Hex(stableStringify(withoutHash))) {
        return { ok: false, code: 'FAILED_CAPABILITY_RECEIPT_HASH', recordIndex: index };
      }
    }
    if (!validStoredReceipt(entry, index)) {
      return { ok: false, code: 'FAILED_CAPABILITY_RECEIPT_SCHEMA', recordIndex: index };
    }
    if (entry.previousHash !== previousHash) {
      return { ok: false, code: 'FAILED_CAPABILITY_RECEIPT_CHAIN', recordIndex: index };
    }
    previousHash = entry.recordHash;
  }

  return {
    ok: true,
    code: 'CAPABILITY_RECEIPTS_OK',
    recordCount: loaded.entries.length,
    lastRecordHash: loaded.entries.at(-1)?.recordHash ?? null
  };
}

export function createJsonlReceiptSink(receiptPath) {
  if (typeof receiptPath !== 'string' || receiptPath.length === 0) {
    throw codedError('INVALID_CAPABILITY_RECEIPT_PATH');
  }
  return function appendCapabilityReceipt(receipt) {
    if (!validReceiptFacts(receipt)) throw codedError('FAILED_CAPABILITY_RECEIPT_SCHEMA');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    const lockPath = `${receiptPath}.lock`;
    let lockDescriptor;
    let receiptDescriptor;
    let entry;
    let primaryError;
    try {
      lockDescriptor = acquireLock(lockPath);
      const verification = verifyCapabilityReceipts(receiptPath);
      if (!verification.ok) throw codedError(verification.code);

      const withoutHash = {
        schemaVersion: 'path.capability-receipt.v1',
        sequence: verification.recordCount + 1,
        ...receipt,
        previousHash: verification.lastRecordHash ?? 'GENESIS'
      };
      entry = {
        ...withoutHash,
        recordHash: sha256Hex(stableStringify(withoutHash))
      };
      receiptDescriptor = fs.openSync(receiptPath, 'a');
      fs.writeSync(receiptDescriptor, `${JSON.stringify(entry)}\n`, null, 'utf8');
      fs.fsyncSync(receiptDescriptor);
    } catch (error) {
      primaryError = error?.code?.startsWith('FAILED_CAPABILITY_')
        ? error
        : codedError('FAILED_CAPABILITY_RECEIPT_WRITE', error);
    } finally {
      if (receiptDescriptor !== undefined) {
        try { fs.closeSync(receiptDescriptor); } catch (error) {
          primaryError ??= codedError('FAILED_CAPABILITY_RECEIPT_WRITE', error);
        }
      }
      if (lockDescriptor !== undefined) {
        try { fs.closeSync(lockDescriptor); } catch (error) {
          primaryError ??= codedError('FAILED_CAPABILITY_RECEIPT_LOCK_CLEANUP', error);
        }
        try { fs.unlinkSync(lockPath); } catch (error) {
          primaryError ??= codedError('FAILED_CAPABILITY_RECEIPT_LOCK_CLEANUP', error);
        }
      }
    }
    if (primaryError) throw primaryError;
    return Object.freeze(entry);
  };
}
