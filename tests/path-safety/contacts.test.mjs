import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadContacts,
  findPersonByEmail,
  findPersonByName,
  isAlreadyContacted,
  isContactedOnChannel,
  isContactedByNameOnChannel,
  canonicalChannel,
  upsertContact,
  markContactedFromBackfill
} from '../../path-safety/contacts.mjs';

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-contacts-'));
  const filePath = path.join(dir, 'contacts.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return filePath;
}

function readLines(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean) : [];
}

test('loadContacts returns an empty map for a missing file', () => {
  const map = loadContacts('C:/definitely/not/here/contacts.jsonl');
  assert.equal(map.size, 0);
});

test('upsert first contact creates envelope with contactId, channel, firstSeenAt, history, lastContactedAt', (t) => {
  const filePath = tempFile(t);
  const at = '2026-08-08T01:40:00.000Z';
  const record = upsertContact(filePath, {
    name: 'Hiring Manager',
    email: 'Hm@Example.com',
    channel: 'email',
    at,
    applicationId: 12
  });

  assert.match(record.contactId, /^c-[a-f0-9]{16}$/);
  assert.equal(record.name, 'Hiring Manager');
  assert.equal(record.email, 'Hm@Example.com'); // first-seen verbatim
  assert.deepEqual(record.channels, [{ channel: 'email', address: 'Hm@Example.com', firstSeenAt: at }]);
  assert.equal(record.history.length, 1);
  assert.deepEqual(record.history[0], {
    event: 'contacted', at, source: 'dispatch', channel: 'email', applicationId: 12
  });
  assert.equal(record.lastContactedAt, at);

  assert.equal(readLines(filePath).length, 1); // append-only single line
});

test('repeat email appends a history event, keeps firstSeenAt, and bumps lastContactedAt', (t) => {
  const filePath = tempFile(t);
  const first = upsertContact(filePath, {
    name: 'HM', email: 'hm@example.com', channel: 'email', at: '2026-07-01T09:00:00.000Z', applicationId: 5
  });
  const second = upsertContact(filePath, {
    name: 'Hiring Manager', email: 'hm@example.com', channel: 'email',
    at: '2026-08-08T02:00:00.000Z', applicationId: 12
  });

  assert.equal(second.contactId, first.contactId);
  assert.equal(second.history.length, 2);
  assert.equal(second.history[1].applicationId, 12);
  assert.equal(second.history[1].at, '2026-08-08T02:00:00.000Z');
  // firstSeenAt never rewrites; name fills only when missing
  assert.equal(second.channels.length, 1);
  assert.equal(second.channels[0].firstSeenAt, '2026-07-01T09:00:00.000Z');
  assert.equal(second.name, 'HM');
  assert.equal(second.lastContactedAt, '2026-08-08T02:00:00.000Z');
  assert.equal(readLines(filePath).length, 2); // append-only again
});

test('email case is normalized for identity (Hm@X.com == hm@x.com)', (t) => {
  const filePath = tempFile(t);
  upsertContact(filePath, { email: 'Hm@X.com', channel: 'email', at: '2026-08-01T00:00:00.000Z' });
  const map = loadContacts(filePath);
  assert.equal(map.size, 1);
  const person = findPersonByEmail(map, '  hm@x.com ');
  assert.ok(person);
  assert.equal(person.email, 'Hm@X.com');
  assert.equal(isAlreadyContacted(map, 'hm@x.com'), true);
});

test('last line wins per contactId on load', (t) => {
  const filePath = tempFile(t);
  upsertContact(filePath, { email: 'a@example.com', name: 'Alpha', channel: 'email', at: '2026-07-01T00:00:00.000Z' });
  upsertContact(filePath, { email: 'a@example.com', channel: 'email', at: '2026-08-01T00:00:00.000Z' });
  upsertContact(filePath, { email: 'b@example.com', name: 'Beta', channel: 'linkedin', at: '2026-08-02T00:00:00.000Z' });
  const map = loadContacts(filePath);
  assert.equal(map.size, 2);
  const alpha = findPersonByEmail(map, 'a@example.com');
  assert.equal(alpha.history.length, 2); // merged (last line authoritative)
  assert.equal(alpha.lastContactedAt, '2026-08-01T00:00:00.000Z');
  assert.equal(alpha.name, 'Alpha'); // carried into the merge
});

test('isAlreadyContacted truth table', (t) => {
  const filePath = tempFile(t);
  assert.equal(isAlreadyContacted(loadContacts(filePath), 'nobody@example.com'), false);
  upsertContact(filePath, { email: 'one@example.com', channel: 'email', at: '2026-08-01T00:00:00.000Z' });
  assert.equal(isAlreadyContacted(loadContacts(filePath), 'one@example.com'), true);
  // Cross-channel: a LinkedIn contact still counts against the same email.
  upsertContact(filePath, { email: 'linked@example.com', channel: 'linkedin', at: '2026-08-02T00:00:00.000Z' });
  assert.equal(isAlreadyContacted(loadContacts(filePath), 'linked@example.com'), true);
});

test('canonicalChannel maps gmail to email and passes the rest through trimmed', () => {
  assert.equal(canonicalChannel('gmail'), 'email');
  assert.equal(canonicalChannel('Gmail'), 'email');
  assert.equal(canonicalChannel('email'), 'email');
  assert.equal(canonicalChannel('linkedin'), 'linkedin');
  assert.equal(canonicalChannel(' LinkedIn '), 'linkedin');
  assert.equal(canonicalChannel(''), undefined);
  assert.equal(canonicalChannel(undefined), undefined);
  assert.equal(canonicalChannel(null), undefined);
});

test('isContactedOnChannel truth table — same channel blocks, other channels do not', (t) => {
  const filePath = tempFile(t);
  const map = loadContacts(filePath);
  assert.equal(isContactedOnChannel(map, 'nobody@example.com', 'email'), false);
  assert.equal(isContactedOnChannel(map, 'nobody@example.com', 'linkedin'), false);

  // Email-contact only: email blocks, LinkedIn does not, gmail alias matches.
  upsertContact(filePath, { email: 'a@example.com', channel: 'email', at: '2026-08-01T00:00:00.000Z' });
  assert.equal(isContactedOnChannel(loadContacts(filePath), 'a@example.com', 'email'), true);
  assert.equal(isContactedOnChannel(loadContacts(filePath), 'a@example.com', 'gmail'), true); // alias
  assert.equal(isContactedOnChannel(loadContacts(filePath), 'a@example.com', 'linkedin'), false);

  // LinkedIn-contact only: email does not block.
  upsertContact(filePath, { email: 'b@example.com', channel: 'linkedin', at: '2026-08-02T00:00:00.000Z' });
  assert.equal(isContactedOnChannel(loadContacts(filePath), 'b@example.com', 'linkedin'), true);
  assert.equal(isContactedOnChannel(loadContacts(filePath), 'b@example.com', 'email'), false);

  // Both channels: each blocks.
  upsertContact(filePath, { email: 'c@example.com', channel: 'email', at: '2026-08-01T00:00:00.000Z' });
  upsertContact(filePath, { email: 'c@example.com', channel: 'linkedin', at: '2026-08-03T00:00:00.000Z' });
  assert.equal(isContactedOnChannel(loadContacts(filePath), 'c@example.com', 'email'), true);
  assert.equal(isContactedOnChannel(loadContacts(filePath), 'c@example.com', 'linkedin'), true);
});

test('isContactedOnChannel fails closed — blank channel falls back to any-history', (t) => {
  const filePath = tempFile(t);
  upsertContact(filePath, { email: 'd@example.com', channel: 'linkedin', at: '2026-08-02T00:00:00.000Z' });
  // Blank/untold channel = conservative old behavior: any history blocks.
  assert.equal(isContactedOnChannel(loadContacts(filePath), 'd@example.com', undefined), true);
  assert.equal(isContactedOnChannel(loadContacts(filePath), 'd@example.com', ''), true);
  assert.equal(isContactedOnChannel(loadContacts(filePath), 'nobody@example.com', undefined), false);
});

test('markContactedFromBackfill writes a source=backfill history event', (t) => {
  const filePath = tempFile(t);
  const record = markContactedFromBackfill(filePath, {
    name: 'Recruiter', email: 'r@example.com', channel: 'email', at: '2026-08-03T00:00:00.000Z'
  });
  assert.equal(record.history[0].source, 'backfill');
  assert.equal(record.history[0].applicationId, null);
});

test('a new channel for the same person is added, never duplicated', (t) => {
  const filePath = tempFile(t);
  upsertContact(filePath, { email: 'p@example.com', channel: 'email', at: '2026-07-01T00:00:00.000Z' });
  upsertContact(filePath, { email: 'p@example.com', channel: 'linkedin', at: '2026-08-01T00:00:00.000Z' });
  upsertContact(filePath, { email: 'p@example.com', channel: 'linkedin', at: '2026-08-02T00:00:00.000Z' });
  const person = findPersonByEmail(loadContacts(filePath), 'p@example.com');
  assert.equal(person.channels.length, 2); // email + linkedin, linkedin line not duplicated
  assert.equal(person.history.length, 3);
  assert.equal(person.channels.find((c) => c.channel === 'linkedin').firstSeenAt, '2026-08-01T00:00:00.000Z');
});

test('a corrupt line throws FAILED_CONTACTS_MALFORMED', (t) => {
  const filePath = tempFile(t);
  fs.writeFileSync(filePath, '{"contactId":"c-0123456789abcdef","email":"ok@example.com"}\n{not json}\n', 'utf8');
  assert.throws(() => loadContacts(filePath), (e) => e.code === 'FAILED_CONTACTS_MALFORMED');
});

test('a valid-JSON non-object entry throws FAILED_CONTACTS_MALFORMED', (t) => {
  const filePath = tempFile(t);
  fs.writeFileSync(filePath, '"just a string"\n', 'utf8');
  assert.throws(() => loadContacts(filePath), (e) => e.code === 'FAILED_CONTACTS_MALFORMED');
});

test('upsert without an email creates a name-only record with a c-n- id', (t) => {
  const filePath = tempFile(t);
  const record = upsertContact(filePath, {
    name: '  Sarah   Chen ', channel: 'linkedin', at: '2026-08-09T10:00:00.000Z', applicationId: 12
  });
  assert.match(record.contactId, /^c-n-[a-f0-9]{16}$/);
  assert.equal(record.name, '  Sarah   Chen '); // first-seen verbatim
  assert.equal(record.email, null);
  assert.deepEqual(record.channels, [{ channel: 'linkedin', address: '  Sarah   Chen ', firstSeenAt: '2026-08-09T10:00:00.000Z' }]);
  assert.equal(record.history.length, 1);
  assert.equal(record.history[0].channel, 'linkedin');
  assert.equal(readLines(filePath).length, 1);
});

test('a name-only upsert merges into the same record across spellings', (t) => {
  const filePath = tempFile(t);
  const first = upsertContact(filePath, {
    name: 'Sarah Chen', channel: 'linkedin', at: '2026-08-01T00:00:00.000Z'
  });
  const second = upsertContact(filePath, {
    name: '  SARAH  CHEN ', channel: 'email', at: '2026-08-09T10:00:00.000Z'
  });
  assert.equal(second.contactId, first.contactId);
  assert.equal(second.history.length, 2);
  assert.equal(second.history[1].channel, 'email');
  assert.equal(readLines(filePath).length, 2); // append-only
});

test('findPersonByName normalizes case and whitespace and never matches an email-keyed record', (t) => {
  const filePath = tempFile(t);
  upsertContact(filePath, { name: 'Sarah Chen', channel: 'linkedin', at: '2026-08-01T00:00:00.000Z' });
  upsertContact(filePath, { name: 'Alex Doe', email: 'alex@example.com', channel: 'email', at: '2026-08-02T00:00:00.000Z' });
  const map = loadContacts(filePath);
  // Name-only found despite whitespace/case differences.
  assert.ok(findPersonByName(map, '  sarah   chen '));
  assert.equal(findPersonByName(map, 'Sarah Chen').name, 'Sarah Chen');
  // An email-keyed record is a different identity — never resolved by name.
  assert.equal(findPersonByName(map, 'Alex Doe'), undefined);
  // Non-matching name.
  assert.equal(findPersonByName(map, 'Nobody'), undefined);
});

test('isContactedByNameOnChannel truth table — same channel blocks, others do not', (t) => {
  const filePath = tempFile(t);
  const map = loadContacts(filePath);
  assert.equal(isContactedByNameOnChannel(map, 'Sarah Chen', 'linkedin'), false);
  assert.equal(isContactedByNameOnChannel(map, 'Sarah Chen', 'email'), false);

  upsertContact(filePath, { name: 'Sarah Chen', channel: 'linkedin', at: '2026-08-01T00:00:00.000Z' });
  assert.equal(isContactedByNameOnChannel(loadContacts(filePath), 'Sarah Chen', 'linkedin'), true);
  assert.equal(isContactedByNameOnChannel(loadContacts(filePath), 'Sarah Chen', 'email'), false); // cross-channel allowed
  assert.equal(isContactedByNameOnChannel(loadContacts(filePath), 'sarah  chen', 'linkedin'), true); // normalized name
  assert.equal(isContactedByNameOnChannel(loadContacts(filePath), 'Someone Else', 'linkedin'), false);
});

test('isContactedByNameOnChannel fails closed — blank channel falls back to any-history', (t) => {
  const filePath = tempFile(t);
  upsertContact(filePath, { name: 'Sarah Chen', channel: 'linkedin', at: '2026-08-01T00:00:00.000Z' });
  assert.equal(isContactedByNameOnChannel(loadContacts(filePath), 'Sarah Chen', undefined), true);
  assert.equal(isContactedByNameOnChannel(loadContacts(filePath), 'Sarah Chen', ''), true);
  assert.equal(isContactedByNameOnChannel(loadContacts(filePath), 'Nobody', undefined), false);
});

test('markContactedFromBackfill records a name-only contact with source=backfill', (t) => {
  const filePath = tempFile(t);
  const record = markContactedFromBackfill(filePath, {
    name: 'Recruiter', channel: 'phone', at: '2026-08-03T00:00:00.000Z'
  });
  assert.match(record.contactId, /^c-n-/);
  assert.equal(record.email, null);
  assert.equal(record.history[0].source, 'backfill');
  assert.equal(record.history[0].channel, 'phone');
});
