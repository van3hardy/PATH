# Contact Graph — People Ledger

The people ledger (`data/contacts.jsonl`) turns "prevent duplicate contact" from per-application into **per-person**. It is the foundation of the deferred contact-graph build.

Spec: [`docs/superpowers/specs/2026-08-08-contact-graph-design.md`](../superpowers/specs/2026-08-08-contact-graph-design.md).
Implementation plan: [`docs/superpowers/plans/2026-08-08-contact-graph.md`](../superpowers/plans/2026-08-08-contact-graph.md).

## Purpose

A person contacted for one role must not be re-outreached under a different role, company, or packet — even when the application differs. The ledger keys dedup by person: the same normalized email always maps to the same stable `contactId`.

## Record shape

Append-only JSONL; the last line per `contactId` is authoritative.

```json
{
  "contactId": "c-cd4806701d980272",
  "name": "Hiring Manager",
  "email": "Hiring.Manager@example.com",
  "channels": [
    { "channel": "email", "address": "Hiring.Manager@example.com", "firstSeenAt": "2026-08-08T20:21:57.376Z" }
  ],
  "history": [
    { "event": "contacted", "at": "2026-08-08T20:21:57.376Z", "channel": "email", "applicationId": null, "source": "dispatch" }
  ],
  "lastContactedAt": "2026-08-08T20:21:57.376Z"
}
```

- `contactId` = `c-<sha256(email.trim().toLowerCase()).slice(0,16)>` — deterministic, case-insensitive.
- `source` is one of `dispatch` (send), `backfill` (seed), `manual` (future humanscript).
- The file is never rewritten in place; repeat contact appends a new merged line with the full growing `history`.

## Module API — `path-safety/contacts.mjs`

Pure fs + crypto, mirrors `audit-ledger.mjs` discipline.

- `loadContacts(filePath) → Map<contactId, record>` — last line wins; missing file = empty map; corrupt line throws `FAILED_CONTACTS_MALFORMED`.
- `findPersonByEmail(contacts, email) → record | undefined` — case-insensitive match.
- `isAlreadyContacted(contacts, email) → boolean` — true iff the person has a non-empty `history`.
- `upsertContact(filePath, { name, email, channel, at, applicationId, source = 'dispatch' }) → record`
- `markContactedFromBackfill(filePath, { name, email, channel, at, applicationId }) → record`

Unit tests: `tests/path-safety/contacts.test.mjs`.

## Dispatch gate — `scripts/path-dispatch.mjs`

`--contacts <path>` is an optional flag on both `--dry-run` and `--send`:

```
node scripts/path-dispatch.mjs <packet> <approvals> <dispatches> <audit> --send [--contacts data/contacts.jsonl]
```

- Absent flag or missing file → the gate behaves exactly as before (no behavior change).
- Recipient already in the ledger with history → status `BLOCKED_ALREADY_CONTACTED` (exit 1); the hard stop lives here, not in the draft.
- A corrupt ledger → `BLOCKED_INVALID_CONTACTS` (exit 1), never silent.
- On a successful `--send`, the recipient is written back as `{ source: 'dispatch' }`. A write-back failure keeps exit 0 `DISPATCHED` but surfaces `contactWriteError` on stdout — the dispatch already happened.

Integration tests: `tests/path-safety/dispatch-send.test.mjs`.

## Workflow advisory note — `path-workflows/recruiter/recruiter-workflow.mjs`

Before the draft is generated, the run reads `data/contacts.jsonl` (via `dataPaths`) and — if the recipient already has contact history — appends an advisory line to the run summary:

```
- Contact history: Already contacted 2026-07-30T01:31:14.290Z via email.
```

Advisory only: the run stays `HUMAN_REVIEW`/`LOCAL_REVIEW_READY`. A corrupt ledger here is a real failure (`FAILED_CONTACTS_MALFORMED`), never silent.

## One-time backfill — `scripts/contacts-backfill.mjs`

Seeds the ledger idempotently from:

1. `data/applications.md` tracker notes (via `extractContacts`), using each row's company and date.
2. `data/path-outbox.jsonl` + `data/path-dispatch.jsonl` recipient addresses.

- Re-runnable: second run reports zero deltas.
- Absent source files are skipped silently (they read as empty, not errors).
- A corrupt/corrupt `contacts.jsonl` aborts with a non-zero exit before seeding.

```powershell
node scripts/contacts-backfill.mjs
```

## Deferred follow-ups

- Graph edges (person ↔ companies, roles, timeline).
- Web surface (`/api/contacts`).
- Channel-scoped dedup (e.g. email-only vs LinkedIn-only re-contact policies).
- Dedup on name-only contacts (no email yet).