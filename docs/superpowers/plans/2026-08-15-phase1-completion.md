# Plan: Phase 1 completion (roadmap 1.1/1.2/1.3 close-out)

Date: 2026-08-15

## Objective

Finish Phase 1 of the PATH roadmap — get the full suite green, tick plan
files, update roadmap/gap-review statuses, and commit the close-out.
Design docs and implementations for 1.1 (contact graph / name-only dedup),
1.2 (career truth store), 1.3 (learning loop) are already merged at
`0f5de2f`. Remaining: 2 suite failures, doc ticks, commit, cleanup.

## Steps

### 1. SYSTEM_PATHS coverage gap (`learning-loop.mjs`)

`learning-loop.mjs` is git-tracked (committed in `0f5de2f`) but missing from
`update-system.mjs` SYSTEM_PATHS/USER_PATHS, so
`validate-system-paths-coverage.mjs` fails listing only that file.

- Add `'learning-loop.mjs'` to SYSTEM_PATHS in `update-system.mjs`.
- Verify: `node validate-system-paths-coverage.mjs` → `OK: N covered`.

### 2. js-yaml sweep ENOENT (web test renames)

`tests/js-yaml-import-form.test.mjs` scans `git ls-files` (the index). Five
old `web/test-*.mjs` paths are still in the index but deleted on disk; the
real tests live under `web/tests/**` and are untracked.

- Stage the rename set (5 deletions + 5 additions).
- Verify: `node --test tests/js-yaml-import-form.test.mjs` passes and
  `git ls-files "web/tests/**/*.test.mjs"` returns 5 files.

### 3. Full suite

- Detached `node test-all.mjs` with redirected log (~25 min).
- Expect: 3470+ passed / 0 failed / 1 warning (symlink EPERM skip,
  pre-existing environmental).

### 4. Doc ticks

- Tick last checkbox in
  `docs/superpowers/plans/2026-08-14-career-truth-store.md`.
- roadmap 1.1/1.2/1.3 → ✅ with date; gap-review #10 → ✅.

### 5. Commit

- Surgical commit: `update-system.mjs`, web test renames, plan/design docs,
  roadmap/gap-review ticks. Not the ~1041-file pre-existing upstream drift.

### 6. Cleanup

- Remove `.tmp-script-test-3eEWa9/` + `.tmp-script-test-sgRyRS/`.
- Keep `modes/_brief.md` + `HANDOFF.md` (user decision).

## Decisions (user-confirmed 2026-08-15)

- `.disciplined-work` gate: keep documented variance — do NOT fabricate
  `run_gate.py`.
- Commit the close-out after green.
- Remove tmp dirs; keep `_brief.md` + `HANDOFF.md`.

## Exit criteria

- [x] `validate-system-paths-coverage.mjs` OK (1101 covered).
- [x] js-yaml sweep green; 5 web test suites tracked under `web/tests/`.
- [x] Full `node test-all.mjs`: 3472 passed / 0 failed / 1 warning.
- [x] Plan file ticked; roadmap 1.1/1.2/1.3 + gap-review #10 ✅.
- [ ] Close-out committed.
- [ ] Tmp dirs removed.