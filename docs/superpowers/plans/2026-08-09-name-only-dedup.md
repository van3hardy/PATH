# Plan: Name-only dedup

Date: 2026-08-09
Depends on: `docs/superpowers/specs/2026-08-09-name-only-dedup-design.md`

## Goal

Stop skipping name-only contacts (a person known by name but with no email
yet) in the people ledger, and gate dispatch on them by exact canonical name,
with the same channel scoping as email-keyed dedup.

## Steps

1. **Schema** (`path-safety/contacts.mjs`)
   - Add `canonicalName(name)` and `contactIdForName(name)` → `c-n-<sha256>`.
   - Relax `buildRecord` validation to name **or** email required.
   - `upsertContact` prior-lookup by email when present, else by name.
2. **Predicates** (`path-safety/contacts.mjs`)
   - `findPersonByName(contacts, name)` — name-only records only.
   - `isContactedByNameOnChannel(contacts, name, channel)` — channel-scoped,
     blank channel fails closed to any-history.
3. **Gate** (`scripts/path-dispatch.mjs`) — after the email check, consult the
   name-only predicate; email path decides first.
4. **Backfill** (`scripts/contacts-backfill.mjs`) — seed name-only contacts
   when name + channel known; skip only when neither identity or untold
   channel.
5. **Tests** — `tests/path-safety/contacts.test.mjs` + `dispatch-send.test.mjs`.
6. **Docs** — `docs/path/contact-graph.md`, `docs/path/gap-review.md`,
   contact-graph design spec §13.

## Definition of done

- New unit + integration tests green; full `tests/path-safety/*.test.mjs`,
  recruiter-workflow, and web suites green; `web/` `tsc --noEmit` clean.
- A name-only LinkedIn record blocks a LinkedIn dispatch, allows an email
  dispatch, and never blocks a packet whose address resolves to a person.