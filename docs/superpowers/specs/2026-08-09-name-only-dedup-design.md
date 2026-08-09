# Design: Name-only dedup

Date: 2026-08-09

## Problem

`contacts-backfill.mjs` silently skips contacts that have a name but no email
(`if (!email) continue;`), and the ledger schema requires an email for every
record. A person who was contacted before an email was ever recorded (e.g. a
LinkedIn touch from tracker notes that named the person but not an address)
therefore cannot be deduped: a later dispatch to that person's eventual email
is never blocked, even though the person was already outreached.

## Design

Extend the ledger to hold **name-only** records (no email) and gate the
dispatch on them by exact canonical name.

### Schema (`path-safety/contacts.mjs`)

- `contactIdForName(name)` → `c-n-<sha256("name:<canonicalName>")[:16]>`. The
  distinct `c-n-` prefix guarantees no collision with email-derived
  `c-<hash>` IDs.
- `canonicalName(name)`: trim, lowercase, collapse internal whitespace.
- `buildRecord` validation relaxes from "email required" to **name OR email
  required**; channel remains required. Record stores `email: email ?? null`
  and `name: name ?? null`.
- `upsertContact` / `markContactedFromBackfill`: prior-lookup by email when an
  email is present, otherwise by canonical name.

### Predicates

- `findPersonByName(contacts, name)`: returns the first record whose
  `email` is absent and whose `name` canonicalizes to the needle. A record
  that carries a (different) email is a different person — never matched by
  name.
- `isContactedByNameOnChannel(contacts, name, channel)`: true iff the
  name-only person has a prior `history` event on the intended channel.
  Blank channel fails closed to any-history (mirrors `isContactedOnChannel`).

### Gate (`scripts/path-dispatch.mjs`)

After the email-keyed check: if `isContactedOnChannel(recipient.address,
channel)` is false, consult `isContactedByNameOnChannel(recipient.name,
channel)`. Email path decides first — a name-only record never blocks a
packet whose address already resolves to a person.

### Backfill (`scripts/contacts-backfill.mjs`)

Replace the email-only skip with: if no email but a name **and** a detected
channel are present, record name-only; skip only when neither identity is
known or the channel is untold (an unknown-channel mention is not recordable
evidence).

### No cross-identity merging

A name-only record and a later email record for the same person stay separate
records (that is the "no email yet" reality). The gate handles both correctly:
name-only blocks via the name path, email-keyed blocks via the email path.

### Testing

- `contacts.test.mjs`: name-only upsert shape + contactId stability;
  `findPersonByName` normalization; `isContactedByNameOnChannel` truth table
  (same-channel true, cross-channel false, no-match false, blank-channel
  fail-closed); email-keyed record never found by name.
- `dispatch-send.test.mjs`: name-only prior LinkedIn record blocks a LinkedIn
  packet, allows an email packet (cross-channel), allows a different name.
