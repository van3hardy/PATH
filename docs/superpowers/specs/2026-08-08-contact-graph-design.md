# Contact Graph — People Ledger for Duplicate-Outreach Prevention

> **Status:** Design (approved) · **Date:** 2026-08-08 · **Applies to:** `C:\Users\van1h\Documents\GitHub\Path` (branch `main`)

## 1. Problem

The repo has no people database. Contact handling is:

- `followup-cadence.mjs` `extractContacts()` parses ad-hoc `{ name, email, channel }` strings out of tracker notes, per `data/applications.md` row — no persistent store, discarded after each run.
- The outbox packet carries `recipient: { name, address }` (see the current demo packet), but nobody remembers who was reached.
- Dispatch idempotency (`BLOCKED_ALREADY_DISPATCHED`) dedupes by *packet*, not by *person*. The same person can be drafted and dispatched across two different applications.

Primary goal: **prevent duplicate outreach to the same person** across applications and channels.

## 2. Out of scope (follow-ups, not now)

- Graph edges (company / role / application nodes) — the §14 subsystem #5 full graph is a later build.
- Web `/api/contacts` surface and contact-history UI.
- Channel-specific dedup (e.g. "never two LinkedIn messages") — dedup is email-based and cross-channel.

## 3. Divergence from the gap review verdict

The gap review (§2 #5, §6 #5, §7) correctly says a people data model is missing. This design is the **first, narrow slice** of that subsystem: a persistent, append-only JSONL people ledger with a duplicate-outreach predicate, wired into the existing safety gate. Edge/relationship machinery is deferred by design (YAGNI).

## 4. Storage

`data/contacts.jsonl` — JSONL ledger, one record per person, **append-only with last-line-wins per `contactId`** (the same ledger pattern as `path-audit.jsonl` / `path-dispatch.jsonl`).

Record shape:

```json
{
  "contactId": "c-<16 hex>",
  "name": "Hiring Manager",
  "email": "hm@example.com",
  "channels": [
    { "channel": "email", "address": "hm@example.com", "firstSeenAt": "2026-07-29T21:30:00.000Z" }
  ],
  "history": [
    { "event": "contacted", "at": "2026-08-08T01:40:00.000Z", "channel": "email", "applicationId": 12, "source": "dispatch" }
  ],
  "lastContactedAt": "2026-08-08T01:40:00.000Z"
}
```

- `contactId` is stable: hex digest derived from the first-seen normalized email, so the same person always lands on the same id even across name variants.
- `channels[].address` is the routing address for that channel (email address). A person can have one or multiple channels.
- `history[]` grows with every `dispatch_completed` for that person's email, plus manual backfill records.
- Upsert semantics: **append** a new line; readers take the **last line per `contactId`**. On repeat contact, re-emit the full merged record so the latest line is authoritative. File is never rewritten in place.
- The file is **git-ignored** (the root `.gitignore` catchall `data/*` at line 144 covers it) and is local user data, exactly like the other ledgers.

## 5. Module — `path-safety/contacts.mjs`

Pure, fs + crypto only (same dependency discipline as `audit-ledger.mjs`), no comments beyond what the code explains, no exports of mutation beyond appends.

- `loadContacts(filePath)` → `Map<contactId, record>`; **last line wins** per id. Returns an empty map when the file is missing. Throws on a corrupt (non-object/non-JSON) line, matching `parseJsonl`'s fail-loud behavior.
- `findPersonByEmail(contacts, email)` → `Contact | undefined`; case-insensitive email match.
- `upsertContact(filePath, { name, email, channel, at, applicationId })` → append-only write. First-seen email creates the person; a repeat appends a `{ event: "contacted", at, channel, applicationId, source: "dispatch"|"manual" }` history event, updates the channel entry's `firstSeenAt` if new, and bumps `lastContactedAt`. Returns the new record.
- `isAlreadyContacted(contacts, email)` → `boolean` — the dedup predicate: true iff that person has a non-empty `history` (i.e. a prior contact event) **across any channel**.
- `markContactedFromBackfill(filePath, { name, email, channel, at })` → like `upsertContact` but writes a history event with `source: "backfill"`; used only during the one-time seed.

## 6. Dispatch gate integration (`scripts/path-dispatch.mjs`)

- New optional flag `--contacts <contacts.jsonl>` alongside the four positional args. When present, its contacts load into `evaluateDryRun()`.
- `evaluateDryRun({ packet, approvals, dispatches, auditPath, contacts, now })` gains a `contacts` parameter; when a contact map is provided and `isAlreadyContacted(contacts, packet.recipient.address)` is true, returns `{ status: "BLOCKED_ALREADY_CONTACTED" }`, placed alongside the existing `BLOCKED_ALREADY_DISPATCHED` branch.
- The check applies in `--send` mode (and asserts live in dry-run the same way the dispatch-dupe check does today — the gate reports without sending in both modes; only `--send` actually attempts a transport).
- **When the flag is absent, the gate behaves exactly as today** — no behavior change, no regression.

## 7. Draft warning (`path-workflows/recruiter/recruiter-workflow.mjs`)

- Before drafting, `findPersonByEmail()` against `data/contacts.jsonl`; if the person was contacted before, the draft summary includes: `Already contacted <lastContactedAt> via <channel>.`
- Advisory only — no hard block at draft time. The hard stop lives in the dispatch gate so an already-contacted person can still be drafted, but cannot be re-sent without surfacing the prior contact.

## 8. One-time backfill (`scripts/contacts-backfill.mjs`)

- Reads `data/applications.md` notes, runs `extractContacts()` per row, and records each found contact with a `source: "backfill"` history event (so past outreach is protected, not re-contactable).
- Also seeds receivers from `data/path-outbox.jsonl` and `data/path-dispatch.jsonl` (`recipient.address`).
- **Idempotent:** re-running only appends contacts/events for emails not already present in the store.
- Exit 0 with a summary line; never fails on an absent source file.

## 9. Error handling

- `--contacts` path missing → empty store (load returns `{}` map), gate passes/reports as if there were no contacts — mirrors `readDispatches`.
- Corrupt line in `contacts.jsonl` → thrown error, CLI exits non-zero via the existing error path. Never silent.

## 10. Testing

- New unit suite `tests/path-safety/contacts.test.mjs`:
  - upsert-first-contact creates envelope with `contactId` + `channel+firstSeenAt`.
  - repeat email appends history event and bumps `lastContactedAt`.
  - email case-insensitivity (`Hm@X.com` vs `hm@x.com` are one person).
  - last-line-wins for a rewritten contactId.
  - `isAlreadyContacted` truth table (no history=false; one event=true; cross-channel=true).
  - corrupt-line → throw.
  - missing file → empty map.
- Integration: extend `tests/path-safety/dispatch-send.test.mjs` with an already-contacted case → `BLOCKED_ALREADY_CONTACTED`, no ledger append, no transport call.

## 11. Verification

- `node --test tests/path-safety/*.test.mjs` green (existing + new suites).
- Manual smoke: `--contacts` against a filled fixture blocks the duplicate email with `BLOCKED_ALREADY_CONTACTED` and exit 1.

## 12. Deliverables

- `path-safety/contacts.mjs`
- `tests/path-safety/contacts.test.mjs`
- `scripts/contacts-backfill.mjs`
- `scripts/path-dispatch.mjs` — add `--contacts` flag + `BLOCKED_ALREADY_CONTACTED`
- `tests/path-safety/dispatch-send.test.mjs` — add already-contacted case
- `path-workflows/recruiter/recruiter-workflow.mjs` — pre-draft warning
- `docs/path/contact-graph.md` — follow-up/mapping note (updates the gap review wiring in docs/path/gap-review.md if touched)

## 13. Follow-ups (explicitly deferred)

- ~~Graph edges: `company` / `role` / `application` nodes + edge ledger (gap-review §2 #5 in full)~~ → SHIPPED (derived at read time, additive `graph` block on `/api/contacts`; see plan `2026-08-08-contact-graph-edges.md`).
- ~~Web `/api/contacts` surface for viewing/managing the ledger~~ → SHIPPED (commit `09c0bc5`).
- ~~Channel-scoped dedup (LinkedIn — never two LinkedIn messages) and LinkedIn send dedup~~ → SHIPPED. `isContactedOnChannel(contacts, email, channel)` blocks a dispatch only when the person already has history on the packet's intended channel (`packet.action.channel`; `gmail` canonicalizes to `email`); cross-channel touches are allowed; blank channel fails closed to any-history semantics (`isAlreadyContacted`). Write-back records the canonical intended channel, so a second LinkedIn dispatch after a first LinkedIn touch is correctly refused.
- Dedup on name-only contacts (no email yet).