# Plan: Career truth store (roadmap 1.2, gap #3)

Date: 2026-08-14

## Objective

Close gap #3: make `config/path.facts.yml` the authoritative career-truth layer
and wire it into `verify-cv-facts.mjs` as an external verification authority.
Also create the missing real `config/cv-facts.json`.

## Steps

### 1. Populate `config/path.facts.yml`

Append career facts (atomic, `approved: true`, sourced from user-layer files).
Keep the existing 2 PATH-context facts untouched. Each new fact carries
`source` (the user-layer file) and `source_date`.

### 2. Create `config/cv-facts.json`

From `config/cv-facts.example.json` schema, with real values:

- `allow_metrics`: metrics restatable from `config/profile.yml` proof points.
- `allow_facts`: verified employer/title phrases from `cv.md`.
- `forbidden_phrases`: `[]` (example default).
- `warn_phrases`: `[]`.

### 3. Wire `verify-cv-facts.mjs`

- Import `loadFacts` from `path-safety/fact-resolver.mjs`.
- Add `factsPath` option (default `join(ROOT, 'config', 'path.facts.yml')`) to
  `verifyFacts`.
- Approved facts (`.filter(f => f.approved === true)`) join the authority:
  - `allowed` set gains `metricClaims(approvedText)`.
  - non-metric fact check also passes when `sourceContainsFact(approvedNormalized, value)`.
- Thread through `assertFacts` (no change needed — it forwards options) and
  `runCli` (add `--facts <path>` arg).
- Missing/empty facts file ⇒ zero behavioral change.

### 4. Tests

- Extend `runSelfTest()` with facts-path cases.
- New `tests/path-safety/verify-cv-facts-facts.test.mjs` (temp store + temp
  source; four assertions from the design doc).
- Run: `node verify-cv-facts.mjs --self-test`,
  `node --test "tests/path-safety/*.test.mjs"`.

### 5. Docs

- `docs/path/gap-review.md`: mark #3 resolved.
- `docs/path/roadmap.md`: 1.2 → done.
- Keep `docs/superpowers/plans/2026-08-14-career-truth-store.md` as plan file.

### 6. Verify

- `node test-all.mjs` (detached, redirect) — expect 3436+ passed / 0 failed.

## Exit criteria

- [x] `config/path.facts.yml` holds the career facts, all `approved: true`. (verified 2026-08-15: 5 career facts, all `approved: true`)
- [x] `config/cv-facts.json` exists with real values. (verified 2026-08-15)
- [x] `verify-cv-facts.mjs --facts` honors the store; missing store = no change. (verified: `tests/path-safety/verify-cv-facts-facts.test.mjs` green)
- [x] New test file green + self-test green.
- [x] gap-review #3 + roadmap 1.2 updated.
- [x] `node test-all.mjs` green. *(verified 2026-08-15: full detached run 3472 passed / 0 failed / 1 pre-existing environmental warning — symlink EPERM skip)*