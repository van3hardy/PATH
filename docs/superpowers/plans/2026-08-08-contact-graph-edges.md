# Contact Graph Edges — person ↔ company / role / timeline — Implementation Plan

> **For agentic workers:** implement task-by-task, atomic commits, verify each step.

**Goal:** Close the deferred "graph edges" follow-up in `docs/path/contact-graph.md` / `docs/path/gap-review.md` §5. Add a read model that derives **edges** from the existing append-only ledger (`data/contacts.jsonl`) — person ↔ application/company/role/timeline — and expose them on the read-only `/api/contacts` web surface alongside the person records it already returns.

**Architecture:** A pure, JSDoc-typed web helper in `web/src/lib/contact-graph.mjs` — `buildContactGraph(contacts, apps)` derives the edges. The route decodes the tracker (`data/applications.md`) via the existing `web/src/lib/tracker-table.mjs` reader, builds the graph on each GET, and returns it in an additive `graph` block. No new packages, no write path (the ledger stays append-only; the graph is derived, never stored).

**Tech Stack:** Node.js ESM + `node:test` for the helper; Next.js route is GET-only.

## Global Constraints

- `parsePathContacts` and the `/api/contacts` response shape stay unchanged — `graph` is **additive**.
- The builder lives in `web/src/lib/contact-graph.mjs`, is pure (no fs, no Next), JSDoc-typed, and tested by `web/test-contact-graph.mjs`.
- An `applicationId` that can't be resolved against the tracker still yields an edge with `company: null` / `role: null`; a contact with no history yields zero edges; a missing ledger yields `graph: null` alongside `available: false` (unchanged).
- Do **not** touch: the core ledger (`path-safety/contacts.mjs`), write-back in `scripts/path-dispatch.mjs`, or `tests/path-safety/*`.
- Deterministic ordering: edges sorted by `at` (ascending), then `applicationId`.

## What "edges" means

Each contact's `history` is an ordered list of events, each with an optional `applicationId`. The derived graph is:

- **edges**: every ledger event mapped to its application — `{ contactId, applicationId, company, role, at, channel }` (company/role resolved from the tracker when possible).
- **companies**: company → number of *distinct people* contacted about that company (a person counts once per company regardless of event count).
- **people**: per contact — total edge count + the distinct application ids touched.

The tracker (`applications.md`) is the job-side of the graph; its `company`/`role` strings are used verbatim. Missing tracker `n` column → numeric compare so zero-padded `"042"` matches ledger `applicationId: 42`.

## Task 1 — `buildContactGraph` pure builder + tests

**Files:** `web/src/lib/contact-graph.mjs` (add exports, keep `parsePathContacts`), `web/test-contact-graph.mjs`.

**New exports:**
- `buildContactEdges(contact, apps)` → per-event edges for one contact.
- `companyCountByPerson(contacts, apps)` → `{ company: distinctPeople }`.
- `summarizeContacts(contacts, apps)` → `[{ contactId, edges, applications }]`.
- `buildContactGraph(contacts, apps)` → `{ edges, companies, people }` (edges sorted by `at` asc, then `applicationId`).

Tests cover: edge resolution from the tracker fixture; zero-padded `n` ↔ numeric `applicationId`; sort order; distinct-person company counts; unresolved `applicationId` → null company/role without throw; empty history / empty contacts / empty apps degrade gracefully.

## Task 2 — `/api/contacts` route returns `graph`

`GET /api/contacts` now, when `available`, also returns:

```json
{
  "available": true,
  "count": 1,
  "contacts": [ …unchanged… ],
  "graph": {
    "edges": [ { "contactId": "…", "applicationId": 42, "company": "Example Corp", "role": "Ops Manager", "at": "…", "channel": "email" } ],
    "companies": { "Example Corp": 1 },
    "people": [ { "contactId": "…", "edges": 2, "applications": [41, 42] } ]
  }
}
```

Decode `data/applications.md` with `parseApplications(md, rootDir)` from `tracker-table.mjs` when present; absent/malformed → `[]`. Missing ledger → `available: false`, `graph: null`.

## Task 3 — Full safety net

- Full `node --test` tree green across the repo.
- `web/` tsc `--noEmit` green.

## Task 4 — Docs mark graph edges shipped

`docs/path/contact-graph.md` "Deferred follow-ups" → "Graph edges" marked SHIPPED (keep channel-scoped + name-only dedup deferred). `docs/path/gap-review.md` §5 row + §6 item 5 + §7 tail updated.

## Self-Review

- Spec coverage: edges defined per contact; tracker decoded on the web side; ledger is the only write side and stays append-only; forward-compatible additive `graph` block.
- Global constraints: `/api/contacts` backward-stable; no new core modules; corruption → `graph: null`; tests cover the pure builder.