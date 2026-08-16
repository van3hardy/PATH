# Design: Learning loop (roadmap 1.3, gap #10)

Date: 2026-08-14

## Problem

Gap-review item #10 (line 52):

> **Learning loop** — `analyze-patterns.mjs`, `upskill.mjs`, `outcome.mjs`,
> `assessment-log.mjs`, `stats.mjs`, `funnel-velocity.mjs`. Analytics yes; **no
> automated feedback** into graph/brain/strategy.

The analytics scripts compute rich signal (lifetime funnel, funnel velocity and
calibration vs market benchmarks, waiting/cold rows, skill gaps, outcome
feedback logs) but each one is a one-shot CLI that prints to stdout and is
discarded. Nothing aggregates the signal into a single feedback artifact that a
mode, the brain, or the user can act on. Closing the loop means: a single
entrypoint that gathers all analytics, produces one structured feedback
object, and writes it somewhere durable the strategy layer can consume.

Additional constraint discovered while exploring: `analyze-patterns.mjs` has
**no exports** and its `analyze()` reads ROOT-bound data; `test-all.mjs`
(~line 8291) parses it by **fixed index**, so its structure must not change.
The loop therefore must not `import` analyze-patterns.

## Design

A new root script `learning-loop.mjs` — an **empty-safe aggregator** that
imports the existing exported analytics functions, reads the tracker, outcome
logs and reports, and emits a structured, schema-versioned feedback object plus
a human summary. It never fabricates: every field is derived from tracked data
or verbatim outcome feedback.

### Inputs (all read with readIfExists, missing → `null`)

| Source | Path | Used by |
|---|---|---|
| Tracker | `data/applications.md` | stats + funnel-velocity `analyze` |
| Status log | `data/status-log.tsv` | funnel-velocity `analyze` |
| Follow-ups | `data/follow-ups.md` | stats followup metrics |
| States | `templates/states.yml` | funnel-velocity `analyze` |
| Benchmarks | `--benchmarks` → `config/benchmarks.yml` → `templates/benchmarks.yml` (reuse `loadBenchmarks`) | funnel-velocity |
| Reports | `reports/*.md` | upskill `parseReportGaps` / `aggregateGaps` |
| Outcomes | `data/outcomes/{num}_{company}_{role}/outcome.md` | outcome feedback reader |

### Aggregation (pure, unit-testable)

`aggregateFeedback({ trackerContent, logContent, followupsContent,
statesContent, benchmarksContent, reports, outcomeLogs, todayStr })`:

- **Lifetime funnel + followup metrics** via `stats.computeAllStats(...)` when a
  tracker exists (imported from `stats.mjs`; empty tracker → `null`).
- **Velocity + calibration + waiting** via `funnel-velocity.analyze({
  trackerContent, logContent, benchmarks, states, todayStr })` (imported from
  `funnel-velocity.mjs`); empty tracker → `null`.
- **Skill gaps** via `upskill.parseReportGaps` per report then
  `aggregateGaps(reports, knownSkills)` (imported from `upskill.mjs`); no
  reports → `null`.
- **Outcome feedback** via a small local reader that walks
  `data/outcomes/*/outcome.md`, extracting per-entry `## Entry: <date>` blocks:
  `Outcome Type`, `Stage Reached`, `Verbatim Feedback` (the `> ` blockquote).
  Never summarizes or rewrites feedback — verbatim only. No outcomes → `[]`.
- **Patterns lens (subprocess, optional):** because `analyze-patterns.mjs` has
  no exports and is parsed by fixed index in test-all, the loop runs it as a
  child process (`node analyze-patterns.mjs --json`) **only when the tracker is
  non-empty**. Its JSON (or its `{error}` / insufficient-data response) is
  embedded as `patterns` verbatim. Empty tracker → `patterns: null`. This keeps
  analyze-patterns structurally untouched.

Output shape (schema-versioned):

```json
{
  "schemaVersion": 1,
  "generatedAt": "YYYY-MM-DD",
  "sources": { "tracker": true, "statusLog": true, "outcomes": 2, "reports": 3 },
  "funnel": { ... } | null,
  "velocity": { ... } | null,
  "calibration": { ... } | null,
  "waiting": { ... } | null,
  "skillGaps": { ... } | null,
  "outcomeFeedback": [ { "date": "...", "company": "...", "role": "...",
      "outcomeType": "...", "stageReached": "...", "feedback": "> verbatim" } ],
  "patterns": { ... } | null,
  "recommendations": [ "..." ]
}
```

### Recommendations (derived, never fabricated)

`deriveRecommendations(feedback)` emits only data-driven directives, each
gated on non-null signal:

- funnel present → top funnel action (e.g. low interview→offer rate).
- calibration present → selection-bias / below-range note reusing the
  `BELOW_RANGE_ACTION` language semantics from funnel-velocity (no invented
  numbers).
- waiting present → follow-up candidates count.
- skillGaps present → top 3 gaps by weighted score (exclude known skills).
- outcomeFeedback present → count of positive/negative outcomes + note that
  verbatim feedback is in the artifact.
- empty tracker → single recommendation "Tracker is empty — no learning
  signals yet." (exit 0, not an error).

### CLI

`node learning-loop.mjs [--json] [--summary] [--self-test] [--benchmarks <path>]`

- default: `--summary` human-readable report to stdout.
- `--json`: full feedback object as JSON.
- `--self-test`: built-in fixture assertions (mirrors upskill/funnel-velocity
  self-tests); exit code reflects failures.
- Writes the durable artifact to `data/learning-feedback.json` (overwrite
  latest) — **user-layer, derived artifact**; the "never auto-updated" rule
  covers personalization files (`modes/_profile.md`, `config/profile.yml`,
  `cv.md`), not generated feedback. Never touches personalization.

### Backward compatibility

- New standalone script; no existing file imported or modified.
- `analyze-patterns.mjs` is only **invoked**, never imported or edited (fixed-index constraint honored).
- `stats.mjs` / `funnel-velocity.mjs` / `upskill.mjs` untouched — only imported.

### Non-goals

- No auto-writes to `modes/_profile.md`, `config/profile.yml`, `cv.md`, the
  contact graph, or `path-brain/`. Feedback lands in `data/learning-feedback.json`
  for a mode/agent to consume; wiring it into the brain is Phase 2.
- No new analytics math — reuse existing exports; the loop is an aggregator, not
  a second implementation of stats.

## Test plan

- New `tests/learning-loop.test.mjs` (in-process, temp fixtures via
  `mkdtempSync` + `pathToFileURL` import, following `tests/stats.test.mjs` /
  `tests/outcome.test.mjs` conventions): (a) empty inputs → `{ empty: true }`,
  exit 0; (b) populated temp tracker + status log + states + benchmarks →
  funnel/velocity/calibration/waiting present and correct; (c) temp reports →
  skillGaps computed with known skills excluded; (d) temp outcome log →
  verbatim feedback extracted; (e) recommendations derive only from non-null
  signals.
- `learning-loop.mjs --self-test` green; register `learning-loop.mjs
  --self-test` in the test-all script list.
- Mode-doc gates unaffected (learning-loop is not a required reference in
  patterns/tracker/followup docs).
- Full suite: `node test-all.mjs` stays green (baseline 3436 passed / 0 failed).

## Rollout

Design → plan doc (`docs/superpowers/plans/2026-08-14-learning-loop.md`) →
implement `learning-loop.mjs` → tests → register self-test in test-all →
update gap-review #10 + roadmap 1.3 → full `test-all.mjs` gate →
`.disciplined-work` gate resolution.
