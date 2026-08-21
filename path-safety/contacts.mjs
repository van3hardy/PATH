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

// Names are normalized the same way for identity purposes: trimmed,
// lowercased, internal runs of whitespace collapsed.
function canonicalName(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

function contactIdFor(email) {
  return `c-${crypto.createHash('sha256')
    .update(canonicalEmail(email), 'utf8')
    .digest('hex')
    .slice(0, 16)}`;
}

// Name-only identity is a distinct namespace (c-n- prefix) so it can never
// collide with an email-derived c-<hash> id.
function contactIdForName(name) {
  return `c-n-${crypto.createHash('sha256')
    .update(`name:${canonicalName(name)}`, 'utf8')
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
    // Tombstone: a superseded name-only row (email promotion). Removes the old
    // contactId so the ledger resolves to exactly one live record per person.
    if (isNonemptyString(entry.supersededBy)) {
      contacts.delete(entry.contactId);
      continue;
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

// Matches only name-only records (records with no email). A record that
// carries a different email is a different person and is never matched by
// name — the email path owns that identity.
export function findPersonByName(contacts, name) {
  if (!isNonemptyString(name)) return undefined;
  const needle = canonicalName(name);
  for (const contact of contacts.values()) {
    if (!isNonemptyString(contact.email) &&
        isNonemptyString(contact.name) &&
        canonicalName(contact.name) === needle) {
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

// Name-only dedup predicate: true iff the name-only person has a prior contact
// event on the intended channel. A blank/untold channel fails closed to the
// conservative any-history behavior, mirroring isContactedOnChannel.
export function isContactedByNameOnChannel(contacts, name, channel) {
  const needle = canonicalChannel(channel);
  const person = findPersonByName(contacts, name);
  if (!person) return false;
  const hasHistory = Array.isArray(person.history) && person.history.length > 0;
  if (!needle) return hasHistory;
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

function mergeChannels(base, extra) {
  let channels = base ?? [];
  for (const entry of extra ?? []) {
    channels = mergeChannel(channels, entry);
  }
  return channels;
}

function buildRecord(prior, input) {
  const { name, email, channel, at, applicationId, source } = input;
  if ((!isNonemptyString(email) && !isNonemptyString(name)) || !isNonemptyString(channel)) {
    throw codify('FAILED_CONTACTS_SCHEMA');
  }
  if (!VALID_SOURCES.includes(source)) throw codify('FAILED_CONTACTS_SCHEMA');
  const historyEvent = { event: 'contacted', at, channel, applicationId: applicationId ?? null, source };
  if (!prior) {
    const identity = isNonemptyString(email) ? { email, address: email } : { name, address: name };
    return {
      contactId: isNonemptyString(email) ? contactIdFor(email) : contactIdForName(name),
      name: name ?? null,
      email: email ?? null,
      channels: [{ channel, address: identity.address, firstSeenAt: at }],
      history: [historyEvent],
      lastContactedAt: at
    };
  }
  return {
    contactId: prior.contactId,
    name: prior.name ?? name ?? null,
    email: prior.email ?? email ?? null,
    channels: mergeChannel(prior.channels ?? [], {
      channel,
      address: isNonemptyString(email) ? email : name,
      firstSeenAt: at
    }),
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

// Promotion: an email arriving for a person previously known only by name
// folds the name-only record's history and channels into the email-keyed
// record. When an email-keyed record already exists too, both histories are
// merged so no outreach evidence is ever split across rows.
function buildPromotedRecord(prior, nameOnly, input) {
  const { name, email, channel, at, applicationId, source } = input;
  const historyEvent = { event: 'contacted', at, channel, applicationId: applicationId ?? null, source };
  return {
    contactId: contactIdFor(email),
    name: prior?.name ?? nameOnly?.name ?? name ?? null,
    email: email ?? null,
    channels: mergeChannels(
      mergeChannel(prior?.channels ?? [], { channel, address: email, firstSeenAt: at }),
      nameOnly?.channels
    ),
    history: [...(prior?.history ?? []), ...(nameOnly?.history ?? []), historyEvent]
      .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))),
    lastContactedAt: at
  };
}

export function upsertContact(filePath, { name, email, channel, at, applicationId, source = 'dispatch' } = {}) {
  const atValue = at ?? new Date().toISOString();
  const contacts = loadContacts(filePath);
  const hasEmail = isNonemptyString(email);
  // Email identity owns a record when an email is present; otherwise the name
  // path owns it (name-only contacts, no email yet).
  const prior = hasEmail
    ? findPersonByEmail(contacts, email)
    : findPersonByName(contacts, name);
  // Promotion: when an email arrives for a person known only by name, the
  // name-only record is merged into the email-keyed record and tombstoned, so
  // the ledger never holds two rows for one person.
  const nameOnly = hasEmail && isNonemptyString(name)
    ? findPersonByName(contacts, name)
    : undefined;
  const needsPromotion = Boolean(nameOnly && nameOnly.contactId !== prior?.contactId);
  const record = needsPromotion
    ? buildPromotedRecord(prior, nameOnly, { name, email, channel, at: atValue, applicationId, source })
    : buildRecord(prior, { name, email, channel, at: atValue, applicationId, source });
  appendRecord(filePath, record);
  if (needsPromotion) {
    appendRecord(filePath, {
      contactId: nameOnly.contactId,
      supersededBy: record.contactId,
      supersededAt: atValue
    });
  }
  return record;
}

export function markContactedFromBackfill(filePath, { name, email, channel, at, applicationId } = {}) {
  return upsertContact(filePath, { name, email, channel, at, applicationId, source: 'backfill' });
}