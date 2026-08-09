# Cover Letter Web Surface — AI-drafted `/api/run` kind — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing `modes/cover.md` + `generate-cover-letter.mjs` pipeline as a web-driven AI job — a new `cover-letter` kind on the existing `/api/run` route (the same one that backs `evaluate`/`pdf`/`fix-portal`/`research`). The agent drafts a tailored letter from the evaluation report + CV/profile, renders the PDF via `generate-cover-letter.mjs`, and reports a VERDICT. No new route or transport; a small button on the report view fires it, mirroring `GeneratePdfButton`.

**Why this shape (user decision, 2026-08-08):** the gap-review gap #4 ("cover letter has no web surface") is closed as an **AI-drafted `/api/run` kind** — the letter content needs drafting, which is real AI work, and the `pdf` kind is the exact precedent for "LLM agent runs the real core script and persists a file." A pure POST `/api/cover-letter` (mechanical render only) was rejected because the letter text has to be authored somewhere and the AI is already present.

**Rationale / non-goals:**
- The worker ONLY drafts + renders. It does NOT submit, contact anyone, or merge the tracker.
- No changes to `generate-cover-letter.mjs`, `modes/cover.md`, the payload schema, or the PDF renderer — this is a web-orchestration surface only. Web ORCHESTRATES the real core, never reimplements it.
- Existing run kinds and their prompts are untouched (only `buildPrompt` gains a branch and the `needsScript`/timeout maps gain a key).

**Tech Stack:** Next.js route handlers (existing `/api/run`), the existing `startJob` worker infra, `node --test` for any pure helpers. No new packages.

## Global Constraints

- The run-kind handler is **read-only orchestrator** — it spawns the user's CLI exactly like `pdf`/`evaluate` do today (streaming NDJSON, honesty gate, cost capture, cancel safety). Reuse every line of that machinery; add a branch, don't fork.
- `input` for `cover-letter` is the application number `n` (same as `pdf`): the agent reads `reports/{n}-*.md` and `data/applications.md#n`.
- The `cover.md` mode is inherently interactive (six research + drafting gates). The web prompt must say "you are headless — proceed without waiting for interactive answers, using the report + profile as the source; research is WebSearch, synthesize; do NOT pause for user confirmation" — mirroring how `pdf` already declares "headless, do not improvise."
- Drafting MUST end by writing a real payload JSON under the real output dir, then `node generate-cover-letter.mjs --payload <path>`. VERDICT `{5 if the PDF exists, else 1}/5 — {output path}`. This matches `pdf` VERDICT convention.
- Do NOT modify existing tests. New logic gets new tests. The run route itself is untested (no Jest infra for route handlers); the NEW pure prompt-builder function is unit-tested.

---

### Task 1: Pure prompt-builder helper

**Files:** Create `web/src/lib/run-cover-prompt.mjs` (pure ESM, JSDoc-typed — importable by both the route and the test, matching `clean-chips.mjs`/`tracker-table.mjs`/`contact-graph.mjs`).
**Test:** Create `web/test-run-cover-prompt.mjs`.

- `buildCoverPrompt({ kind, report, company, role, today }) → string` — returns the instruction text for the `cover` run. Unit-tests assert: mentions `generate-cover-letter.mjs --payload`, `VERDICT`, the model must never hyperlink/submit, tonality reads report+profile.
- - [ ] Step 1: write failing tests (assert prompt contains the required invocation and VERDICT line, and that it explicitly forbids submitting/emailing).

### Task 2: Wire `cover-letter` kind into `/api/run`

**Files:** Edit `web/src/app/api/run/route.ts`.

- **`buildPrompt`**: add a `cover-letter` branch (for `kind === "cover-letter"`) using the helper. Same headless framing as `pdf`.
- **`needsScript`**: `{ ..., "cover-letter": "modes/cover.md" }` — fail fast 400 if the mode file is absent (mirrors the evaluate/file check). Also require `generate-cover-letter.mjs` — reuse the existing `cv.md`/script presence path: the `needsScript` check covers mode; add `generate-cover-letter.mjs`-in-root as a second requirement for this kind (the renderer is the actual artifact).
- **CV gate**: extend the `(kind === "evaluate" || kind === "pdf")` cv.md requirement to include `cover-letter` (a tailored letter needs cv.md too).
- **`tools` map**: `cover-letter` is a writing kind → same allowed set as `pdf`/`evaluate` (Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep; disallow Task,NotebookEdit).
- **kill timer**: like `pdf`, which is also a render: keep the 720_000ms headroom branch for render kinds → add `cover-letter` to that comparison (it renders a PDF too).
- **persist/writeToken**: `cover-letter` does NOT touch the tracker (unlike `pdf`), so no tracker write lock, and the report-count honesty gate stays evaluate-only; the PDF is verified via the VERDICT line (same as `pdf`).

- [ ] verify prompt branch added
- [ ] verify needs/mode/tools/cv gate wired
- [ ] verify kill timer + no write-lock

### Task 3: Report-page button

**Files:** Edit `web/src/components/report-view.tsx` (+ create nothing new).

- Add a `GenerateCoverButton` (or generic "Generate cover letter (PDF)" button in the same toolbar row as `GeneratePdfButton`), using `useJobs().startJob({ title: "Cover letter · {company}", kind: "cover-letter", input: id, page: d })` and a pill while running; when done, the honest `View` link can't point to a file reliably (output path is stochastic) → on done show a "Cover letter written" check + the path text lies in the job detail. Keep it minimal and consistent with the existing button styling.

**Files:** `web/src/components/report-view.tsx`, `web/src/components/generate-cover-button.tsx` (new component mirroring `generate-pdf-button.tsx`, fires the job + running/error states).

Run

### Task 4: Full-suite + docs

- **Files:** patch `docs/path/gap-review.md` #4 row (mark cover-letter web surface done, `net-new kind cover-letter`), `docs/path/repo-sources.md` or `docs/path/recruiter-mvp1.md`? — update `gap-review.md` only (the §archived verdict line stays as "still no cover web page" → update).
- Run the entire canonical root suite (`node --test tests`) + web tests (`node --test web/test-*.mjs`) + `tsc --noEmit` in `web/`. All green.
- Commit each task **atomically** (separate atomic commits per task).

---

### Burndown

- [ ] Task 1: `web/src/lib/run-cover-prompt.ts` + `web/test-run-cover-prompt.mjs` (prompt builder unit tests)
- [ ] Task 2: `/api/run` `cover-letter` kind (buildPrompt branch, needs/tools/cv gate/verify)
- [ ] Task 3: report-view cover-letter button (component + wiring)
- [ ] Task 4: docs/gap-review update + full re-run + commits

---

**Testing (no changes to existing suites):**
- New: buildCoverPrompt unit test (`web/test-run-cover-prompt.mjs`).
- Full: `node --test tests` (root) must stay 0-fail.
- Web: existing `web/test-clean-chips.mjs`, `web/test-contact-graph.mjs` green; `tsc` in `web/` passes. No added `generate-cover-letter.mjs` tests (renderer unchanged).