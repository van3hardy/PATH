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

- `contactId` = `c-<sha256(email.trim().toLowerCase()).slice(0,16)>` — deterministic, case-insensitive. Name-only contacts (no email yet) use a distinct `c-n-<sha256("name:<canonical>").slice(0,16)>` namespace so the two identities can never collide.
- `source` is one of `dispatch` (send), `backfill` (seed), `manual` (future humanscript).
- The file is never rewritten in place; repeat contact appends a new merged line with the full growing `history`.

## Module API — `path-safety/contacts.mjs`

Pure fs + crypto, mirrors `audit-ledger.mjs` discipline.

- `loadContacts(filePath) → Map<contactId, record>` — last line wins; missing file = empty map; corrupt line throws `FAILED_CONTACTS_MALFORMED`.
- `findPersonByEmail(contacts, email) → record | undefined` — case-insensitive match.
- `findPersonByName(contacts, name) → record | undefined` — matches **name-only** records (no email) by canonical name (trim, lowercase, collapsed whitespace). A record carrying an email is a different identity and is never resolved by name.
- `isAlreadyContacted(contacts, email) → boolean` — true iff the person has a non-empty `history` (any channel).
- `canonicalChannel(channel) → string | undefined` — maps the transport/action vocabulary (`gmail` → `email`) to the ledger's channel vocabulary; unknown channels pass through trimmed lowercased; blank → `undefined`.
- `isContactedOnChannel(contacts, email, channel) → boolean` — channel-scoped dedup predicate: true iff the person has a prior contact event on that channel. A blank/untold channel fails closed to `isAlreadyContacted` (any history blocks).
- `isContactedByNameOnChannel(contacts, name, channel) → boolean` — name-only analog of `isContactedOnChannel` for records with no email; same channel-scoping, same fail-closed blank channel.
- `upsertContact(filePath, { name, email, channel, at, applicationId, source = 'dispatch' }) → record` — email identity wins when an email is present; otherwise the name path owns the record (name-only).
- `markContactedFromBackfill(filePath, { name, email, channel, at, applicationId }) → record`

Unit tests: `tests/path-safety/contacts.test.mjs`.

## Dispatch gate — `scripts/path-dispatch.mjs`

`--contacts <path>` is an optional flag on both `--dry-run` and `--send`:

```
node scripts/path-dispatch.mjs <packet> <approvals> <dispatches> <audit> --send [--contacts data/contacts.jsonl]
```

- Absent flag or missing file → the gate behaves exactly as before (no behavior change).
- Recipient already in the ledger with history **on the packet's intended channel** → status `BLOCKED_ALREADY_CONTACTED` (exit 1); the hard stop lives here, not in the draft. Channel-scoped dedup: a prior **email** blocks an email dispatch but not a fresh LinkedIn touch, and vice versa. The intended channel comes from `packet.action.channel` (transport vocabulary; `gmail` counts as `email`). A packet with no channel fails closed to the old any-history behavior.
- Name-only dedup: a recipient whose address resolves to **no** email record is also matched by **exact canonical name** against name-only records (no email yet), using the same channel scoping. The email path always decides first — a name-only record never blocks a packet whose address already resolves to a person.
- A corrupt ledger → `BLOCKED_INVALID_CONTACTS` (exit 1), never silent.
- On a successful `--send`, the recipient is written back as `{ source: 'dispatch' }` **on the canonical intended channel** (e.g. `email` for a `gmail` packet, `linkedin` for `send_linkedin`). A write-back failure keeps exit 0 `DISPATCHED` but surfaces `contactWriteError` on stdout — the dispatch already happened.

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
- Name-only contacts (no email) are now seeded too — a name **and** a detected channel are enough; only a mention with neither identity, or an untold channel, is skipped.
- A corrupt/corrupt `contacts.jsonl` aborts with a non-zero exit before seeding.

```powershell
node scripts/contacts-backfill.mjs
```

## Deferred follow-ups

- ~~Graph edges (person ↔ companies, roles, timeline)~~ → **SHIPPED**, see below.
- ~~Channel-scoped dedup (e.g. email-only vs LinkedIn-only re-contact policies)~~ → **SHIPPED**, see Dispatch gate above (`isContactedOnChannel` + canonical write-back).
- ~~Dedup on name-only contacts (no email yet)~~ → **SHIPPED**, see Dispatch gate above (`findPersonByName` + `isContactedByNameOnChannel`; backfill now seeds them). Name-only and email records for the same person stay separate identities — that is the "no email yet" reality.

## Graph edges (person ↔ companies, roles, timeline)

Built. The web surface now derives edges from the same append-only ledger —
every event in a contact's `history` is mapped to its application, resolving
`company`/`role` from the application tracker (`data/applications.md`), the
job-side of the graph. Derived at read time only; the ledger stays append-only.

Shape (additive `graph` block on `/api/contacts`, backward-compatible):

```json
{
  "edges": [ { "contactId": "…", "applicationId": 42, "company": "Example Corp",
               "role": "Ops Manager", "at": "…", "channel": "email" } ],
  "companies": { "Example Corp": 1 },
  "people": [ { "contactId": "…", "edges": 2, "applications": [41, 42] } ]
}
```

- `edges`: every history event, sorted by `at` asc then `applicationId`. An
  `applicationId` that can't be resolved (deleted/renumbered tracker row) still
  yields an edge with `null` company/role — the ledger is truth for "contacted".
- `companies`: company → number of **distinct people** contacted about it (a
  person counts once per company regardless of event count).
- `people`: per contact — total edge count + distinct application ids touched.
- Application ids compare numerically, so the ledger's numeric `applicationId`
  matches the tracker's zero-padded `n` (`"042"` ↔ `42`).

Pure derivation lives in `web/src/lib/contact-graph.mjs`
(`buildContactGraph`, `buildContactEdges`, `companyCountByPerson`,
`summarizeContacts`) and is regression-tested by `web/test-contact-graph.mjs`.

## Web surface (`/api/contacts`)

Built (commit `09c0bc5`). A read-only GET route decodes the same append-only
ledger the CLI uses (last line per `contactId` wins, matching
`path-safety/contacts.mjs loadContacts`), so the web and CLI can never agree on
different people. Pure parser lives in `web/src/lib/contact-graph.mjs`
(`parsePathContacts`, JSDoc-typed, no Next dependency) and is regression-tested
by `web/test-contact-graph.mjs` (wired into `web/package.json` `test`).