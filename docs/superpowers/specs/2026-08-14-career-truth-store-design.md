# Design: Career truth store (roadmap 1.2, gap #3)

Date: 2026-08-14

## Problem

Gap-review items #3 (lines 21, 45) and #97:

- "**Partial:** no external verification integration; the approved-fact store is
  minimal (2 facts)."
- `verify-cv-facts.mjs` checks generated documents only against the literal
  source files (`cv.md`, `article-digest.md`) plus the `config/cv-facts.json`
  allow-lists. It does **not** consult the approved-fact store, so a claim that
  the owner has already approved (but that is phrased differently in the CV, or
  moved between sections) is flagged as unsupported.
- `config/cv-facts.json` is missing; only `config/cv-facts.example.json`
  (placeholder content) exists. `verify-cv-facts.mjs` defaults to the missing
  file and silently runs with an empty config.

The approved-fact store (`config/path.facts.yml`) currently holds only 2 PATH
project-context facts. The career facts the user actually owns (16-year Amazon
operations career, Operations Lead / Process Assistant, 95%→98% automated area
availability, 154+ certifications, multi-site MA/FL/NH/KS) live scattered in
`cv.md`, `config/profile.yml`, and `modes/_profile.md` — none of them are
recorded as approved facts.

## Design

Two changes make the store an authoritative "career truth" layer that the
existing CV fact gate actually honors.

### 1. Populate the approved-fact store (`config/path.facts.yml`)

Keep the 2 existing PATH-context facts. Add the user's career facts as
individual atomic facts, each `approved: true`, each with `source` pointing at
the user-layer file the fact came from (`cv.md`, `config/profile.yml`,
`modes/_profile.md`) and a `source_date`. Facts are atomic single sentences so
`resolveClaims`/`splitClaims` can match them.

The fact store stays **user-layer** (`config/*` is user layer per the Data
Contract) — never auto-updated, extended only when the owner adds or approves
facts.

### 2. Create `config/cv-facts.json` (real config)

Create the real config from the `config/cv-facts.example.json` schema with
values derived from the user's actual profile:

- `allow_metrics`: metrics present in user-layer profile proof points that a CV
  may legitimately restate (e.g. the availability percentage and course counts
  as they appear in `config/profile.yml`).
- `allow_facts`: verified employer/title phrases already recorded in
  `cv.md`/`modes/_profile.md`.
- `forbidden_phrases` / `warn_phrases`: the standard puffery/tentative-language
  lists from the example (empty by default for this user).

### 3. Wire external verification into `verify-cv-facts.mjs`

Add a `factsPath` option to `verifyFacts` (default
`join(ROOT, 'config', 'path.facts.yml')`) that loads the approved-fact store
and treats approved facts as an additional verification authority, without
requiring verbatim presence in `cv.md`/`article-digest.md`:

- Load approved facts via `loadFacts(factsPath)` (imported from
  `path-safety/fact-resolver.mjs`).
- **Metric claims:** add `metricClaims(approvedText)` to the `allowed` set, so a
  metric that appears in an approved fact passes even if the source files
  phrase it differently.
- **Non-metric facts:** build `allowedFacts` not just from config but also from
  each approved fact's full text; a fact claim whose value appears in any
  approved fact (via `sourceContainsFact`) counts as supported.
- Degrade gracefully: if `config/path.facts.yml` is missing or empty, behavior
  is byte-for-byte identical to today (empty facts → no additional authority).

`assertFacts` and `runCli` thread the new option through unchanged in behavior
when absent. `runCli` gains a `--facts <path>` argument mirroring `--config`.

### Backward compatibility

- Default `factsPath` points at the existing store; existing behavior for
  missing config/empty store is preserved (empty facts = no change).
- The test-all CLI regression (hidden script metric exit 0 / visible
  unsupported metric exit non-null) is unaffected: the seeded facts contain no
  "500 users"-style metrics.
- `path-workflows/recruiter/recruiter-workflow.mjs` and
  `scripts/path-queue.mjs` already use `loadFacts`; no changes there.

### Non-goals

- Do not auto-generate facts from `cv.md` — facts are added by the owner/agent
  deliberately, never inferred.
- Do not touch the evidence-selector (`path-memory/evidence-selector.mjs`) in
  this phase; it already guards recruiter brain requests. Fact-store wiring for
  the brain is Phase 2 territory.

## Test plan

- `verify-cv-facts.mjs --self-test` stays green (add facts-path cases to the
  existing self-test harness).
- New unit test `tests/path-safety/verify-cv-facts-facts.test.mjs`: temp facts
  store + temp source; assert (a) metric in approved fact passes, (b) non-metric
  fact in approved store passes, (c) missing facts file → identical result to
  no-facts invocation, (d) unapproved fact does not pass.
- `node verify-cv-facts.mjs <sample> --config <tmp>` CLI smoke with
  `--facts <tmp>`.
- Full suite: `node test-all.mjs` stays green (baseline 3436 passed / 0 failed).