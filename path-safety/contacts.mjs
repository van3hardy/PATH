import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VALID_SOURCES = ['dispatch', 'manual', 'backfill'];

function codify(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalEmail(email) {
  return String(email).trim().toLowerCase();
}

function contactIdFor(email) {
  return `c-${crypto.createHash('sha256')
    .update(canonicalEmail(email), 'utf8')
    .digest('hex')
    .slice(0, 16)}`;
}

export function loadContacts(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  const contacts = new Map();
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw codify('FAILED_CONTACTS_MALFORMED');
    }
    if (!isPlainObject(entry) || !isNonemptyString(entry.contactId)) {
      throw codify('FAILED_CONTACTS_MALFORMED');
    }
    contacts.set(entry.contactId, entry);
  }
  return contacts;
}

export function findPersonByEmail(contacts, email) {
  if (!isNonemptyString(email)) return undefined;
  const needle = canonicalEmail(email);
  for (const contact of contacts.values()) {
    if (isNonemptyString(contact.email) && canonicalEmail(contact.email) === needle) {
      return contact;
    }
  }
  return undefined;
}

export function isAlreadyContacted(contacts, email) {
  const person = findPersonByEmail(contacts, email);
  return Array.isArray(person?.history) && person.history.length > 0;
}

// Normalizes the transport/action vocabulary (e.g. "gmail") to the ledger's
// channel vocabulary (e.g. "email"). Unknown channels pass through trimmed
// lowercased; a blank channel produces undefined.
export function canonicalChannel(channel) {
  if (!isNonemptyString(channel)) return undefined;
  const trimmed = channel.trim().toLowerCase();
  return trimmed === 'gmail' ? 'email' : trimmed;
}

// Channel-scoped dedup predicate. True iff the person has a prior contact
// event on the given channel. When the channel is blank/untold it fails
// closed to the old behavior (any history blocks), never the reverse.
export function isContactedOnChannel(contacts, email, channel) {
  const needle = canonicalChannel(channel);
  if (!needle) return isAlreadyContacted(contacts, email);
  const person = findPersonByEmail(contacts, email);
  if (!person) return false;
  return Array.isArray(person.history) && person.history.some((event) =>
    event && canonicalChannel(event.channel) === needle);
}

function mergeChannel(channels, { channel, address, firstSeenAt }) {
  if (channels.some((entry) =>
    entry.channel === channel && canonicalEmail(entry.address) === canonicalEmail(address))) {
    return channels;
  }
  return [...channels, { channel, address, firstSeenAt }];
}

function buildRecord(prior, input) {
  const { name, email, channel, at, applicationId, source } = input;
  if (!isNonemptyString(email) || !isNonemptyString(channel)) throw codify('FAILED_CONTACTS_SCHEMA');
  if (!VALID_SOURCES.includes(source)) throw codify('FAILED_CONTACTS_SCHEMA');
  const historyEvent = { event: 'contacted', at, channel, applicationId: applicationId ?? null, source };
  if (!prior) {
    return {
      contactId: contactIdFor(email),
      name: name ?? null,
      email,
      channels: [{ channel, address: email, firstSeenAt: at }],
      history: [historyEvent],
      lastContactedAt: at
    };
  }
  return {
    contactId: prior.contactId,
    name: prior.name ?? name ?? null,
    email: prior.email ?? email,
    channels: mergeChannel(prior.channels ?? [], { channel, address: email, firstSeenAt: at }),
    history: [...(prior.history ?? []), historyEvent],
    lastContactedAt: at
  };
}

function appendRecord(filePath, record) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    throw codify('FAILED_CONTACTS_WRITE', error);
  }
}

export function upsertContact(filePath, { name, email, channel, at, applicationId, source = 'dispatch' } = {}) {
  const atValue = at ?? new Date().toISOString();
  const contacts = loadContacts(filePath);
  const prior = findPersonByEmail(contacts, email);
  const record = buildRecord(prior, { name, email, channel, at: atValue, applicationId, source });
  appendRecord(filePath, record);
  return record;
}

export function markContactedFromBackfill(filePath, { name, email, channel, at, applicationId } = {}) {
  return upsertContact(filePath, { name, email, channel, at, applicationId, source: 'backfill' });
}