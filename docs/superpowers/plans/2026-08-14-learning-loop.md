# Plan: Learning loop (roadmap 1.3, gap #10)

Date: 2026-08-14
Design: `docs/superpowers/specs/2026-08-14-learning-loop-design.md`

## Objective

Close gap #10: a single empty-safe aggregator (`learning-loop.mjs`) that gathers
the existing analytics (stats, funnel-velocity, upskill, outcome feedback,
analyze-patterns) into one schema-versioned feedback artifact written to
`data/learning-feedback.json`, plus `--json` / `--summary` / `--self-test`
outputs.

## Steps

### 1. Scaffold `learning-loop.mjs`

Root script, Node-only (no new deps), header comment documenting the tone
contract (data-derived, never fabricated). Imports:

```js
import { computeAllStats } from './stats.mjs';
import { analyze, loadBenchmarks } from './funnel-velocity.mjs';
import { parseReportGaps, aggregateGaps } from './upskill.mjs';
```

`readIfExists(path)` helper (missing → `null`). `todayStr` =
`new Date().toISOString().slice(0, 10)`.

### 2. Outcome feedback reader

Walk `data/outcomes/*/outcome.md`; for each file parse `## Entry: <date>`
blocks capturing `- **Outcome Type**:`, `- **Stage Reached**:`, and the `> `
blockquote lines (joined verbatim). Company/role from the directory name
(`{num}_{company}_{role}`). Return array; empty dir → `[]`.

### 3. `aggregateFeedback(inputs)` pure function

Takes content strings + `reports` (already parsed by `parseReportGaps`) +
`outcomeLogs` + `todayStr`; returns the schema-versioned object per the design.
Empty tracker → `sources.tracker: false`, funnel/velocity/calibration/waiting
`null`, `patterns: null`. Uses `computeAllStats` only when tracker content is
non-empty.

### 4. `deriveRecommendations(feedback)`

Data-gated directive list per the design. Test that an empty object yields
exactly the empty-tracker recommendation.

### 5. CLI + artifact write

`--summary` (default), `--json`, `--self-test`, `--benchmarks <path>` (passed
through to `loadBenchmarks`). Writes `data/learning-feedback.json` (latest
overwrite). Exit 0 on empty tracker.

### 6. Self-test

Built-in fixture: temp tracker (3 rows: Applied/Interview/Offer), status log,
states, benchmarks (from `templates/benchmarks.yml` content), 1 report, 1
outcome log → assert funnel + velocity + calibration + skillGaps +
outcomeFeedback populated and recommendations non-empty. Also assert the
empty-input branch. `console.log` PASS/FAIL, exit code = failures.

### 7. Tests — `tests/learning-loop.test.mjs`

Temp fixtures (`mkdtempSync` in `os.tmpdir()`), import via `pathToFileURL`,
use `pass`/`fail` from `tests/helpers.mjs` (in-process, never `process.exit()`,
never `finish()`). Cases (a)–(e) from the design test plan.

### 8. Register in `test-all.mjs`

Add `{ name: 'learning-loop.mjs --self-test', run: node learning-loop.mjs --self-test }`
to the script list near the upskill/funnel-velocity self-tests (~line 251–263).

### 9. Docs

- `docs/path/gap-review.md` item #10 → `✅` with a pointer to the design doc.
- `docs/path/roadmap.md` row 1.3 → `2026-08-14-learning-loop-design.md` | `✅`.

### 10. Gate

- Targeted: `node learning-loop.mjs --self-test`; `node --test "tests/learning-loop.test.mjs"`.
- Full: `node test-all.mjs` (detached, log redirect) — expect baseline preserved
  (3436+ passed / 0 failed / 1 warning).
- `.disciplined-work` gate: **variance documented.** `run_gate.py` and the whole
  `.disciplined-work/` dir were never committed to git (verified `git log --all --
  .disciplined-work/` empty; AGENTS.md marker is a plugin injection, no gate file
  anywhere). The roadmap's exit criterion cannot be satisfied as written because
  the referenced artifact does not exist — creating a fabricated gate would assert
  verification that never happened. Variance: the plan's own verification steps
  (self-test + targeted suite + full test-all) stand in for the gate; flagged in
  `docs/path/roadmap.md` note.

## Exit criteria

- `learning-loop.mjs` runs `--self-test` green on an empty tracker (exit 0).
- `tests/learning-loop.test.mjs` passes all fixture cases.
- test-all full run green; roadmap 1.3 `✅`; gap #10 `✅`.

## Out of scope

- Auto-writes to personalization (profile/cv/modes) — never.
- Brain wiring (Phase 2) and analyze-patterns structural changes.