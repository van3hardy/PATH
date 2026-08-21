# PATH Repo Relocation Out of OneDrive — Implementation Plan

**Goal:** Move the canonical active PATH repo from `C:\Users\van1h\OneDrive\Documents\path` to `C:\Users\van1h\Documents\GitHub\Path`, preserving `.git`, `.env`, 4 unpushed commits, and all uncommitted changes, without data loss.

**Architecture:** Same-volume `Move-Item` (single C: drive = instant rename). Destination name vacated by renaming stale clone to `_Path_archive_2026-08-18` (never deleted). Post-move full test suite must go green.

**Tech Stack:** PowerShell 5.1, git, npm/Node, career-ops scripts (doctor.mjs, update-system.mjs, test-all.mjs, verify-pipeline.mjs, plugins.mjs).

## Global Constraints
- NEVER re-clone (origin/main 4 behind local HEAD f4f8b7c, lacks hundreds of uncommitted changes).
- Single-volume rule: source+dest on C: — Move-Item must rename, never copy; cross-volume fallback = stop and ask.
- `.env` is secrets — never moved separately/committed/uploaded; moves with repo only.
- `_Path_archive_2026-08-18` never auto-deleted; its 291 dirty files may hold unique work; deletion requires user approval after diff review.
- No commits, no push during this plan.
- `.bak` files never purged until `node test-all.mjs` green at destination.
- User-layer Data Contract files (cv.md, config/profile.yml, modes/_profile.md, modes/_custom.md, article-digest.md, data/*, reports/*, interview-prep/*) verified present post-move.
- Tools that MUST be used: skills writing-plans, career-ops, verification-before-completion, systematic-debugging (only if gate fails); MCP context-mode (ctx_batch_execute/ctx_execute + re-index), codebase-memory (index_repository), superbased (ui_dump verification); `node plugins.mjs list`; scripts listed; system PowerShell/git/npm. Composio googledrive optional. firecrawl explicitly NOT needed.

## Task 1: Baseline health snapshot (pre-move)
- [ ] Step 1 (at source OneDrive\Documents\path): `git status -sb`; `git log --oneline -6`; `git rev-parse HEAD`; `Test-Path .env; Test-Path .git` → expect branch main, `[ahead 4]`, dirty tree, HEAD f4f8b7c, .env+.git True.
- [ ] Step 2: `node doctor.mjs --json`; `node update-system.mjs check` → doctor onboardingNeeded:false; record update status (do NOT apply).
- [ ] Step 3 (rollback baseline hashes): `Get-FileHash .env, package.json, cv.md, config\profile.yml | Format-Table Path, Hash -AutoSize` → record.
- [ ] Step 4: Print 5-line baseline summary to user (source path, HEAD, ahead-count, dirty-file count, doctor/update status). STOPPING POINT — no move until user confirms.

## Task 2: Vacate destination name
- [ ] Step 1: `Test-Path "C:\Users\van1h\Documents\GitHub\Path"`; Set-Location there; `git status -sb; git rev-parse HEAD` → expect HEAD 05195b8, dirty_count 291.
- [ ] Step 2: `Rename-Item -LiteralPath "C:\Users\van1h\Documents\GitHub\Path" -NewName "_Path_archive_2026-08-18"`; `Test-Path` archive→True, old name→False.
- [ ] Step 3: verify archive integrity: Set-Location archive; `git status -sb; Test-Path .git` → still valid git repo. Rollback: rename back to "Path".

## Task 3: Triage at source (delete safe cruft)
- [ ] Step 1: at source, `git status -sb --untracked-files=all | Select-String -Pattern "New folder|\.superbased"`; `git check-ignore node_modules .env .env.example.bak` → confirm 3 items safe.
- [ ] Step 2: `Remove-Item -LiteralPath "...\New folder" -Recurse -Force`; same for `.superbased`; same for `node_modules`; Test-Path each → all False.
- [ ] Step 3 (verify hard-locks): `@("cv.md","config\profile.yml","modes\_profile.md","modes\_custom.md","article-digest.md","data\applications.md","data\pipeline.md","reports","interview-prep") | ForEach-Object { "{0} -> {1}" -f $_, (Test-Path -LiteralPath $_) }` → all True.
- [ ] Step 4: `git status -sb; git rev-parse HEAD` → still ahead 4, HEAD f4f8b7c.

## Task 4: Move the repo
- [ ] Step 1: `Move-Item -LiteralPath "C:\Users\van1h\OneDrive\Documents\path" -Destination "C:\Users\van1h\Documents\GitHub\Path"`; Test-Path dest→True, source→False. Rollback: Move-Item back if Step 3 fails.
- [ ] Step 2: Set-Location dest; `Test-Path .git; Test-Path .env`; `git status -sb; git rev-parse HEAD` → True/True, HEAD f4f8b7c, ahead 4.
- [ ] Step 3: re-run Task 1 Step 3 Get-FileHash → identical hashes or STOP+rollback.
- [ ] Step 4: stray scaffold untouched: Set-Location `C:\Users\van1h\Documents\path`; `git status` → 'does not have any commits yet'.

## Task 5: Post-move verification — full suite must go green
- [ ] Step 1 (at dest): `npm install` → exit 0.
- [ ] Step 2: `node doctor.mjs --json`; `node update-system.mjs check`; `node plugins.mjs list` → onboardingNeeded:false, update status matches Task 1, plugins OK.
- [ ] Step 3: `node test-all.mjs` → ALL GREEN (exit 0). HARD GATE. On failure: invoke systematic-debugging skill, fix root cause, re-run. Rollback point: if failure is move-related, Move-Item back + restore archive name.
- [ ] Step 4: `node verify-pipeline.mjs` → no structural violations.

## Task 6: Re-point tooling + close loop
- [ ] Step 1: codebase-memory MCP `index_repository(repo_path: "C:\\Users\\van1h\\Documents\\GitHub\\Path", mode "moderate")`; verify `index_status`. Server source lives in sibling Documents\GitHub\codebase-memory-mcp (unaffected).
- [ ] Step 2: context-mode `ctx_index` (or ctx_batch_execute with new cwd) to re-key session knowledge.
- [ ] Step 3: superbased `superbased_ui_dump` targeting Explorer/terminal at Documents\GitHub — confirm `Path` + `_Path_archive_2026-08-18` listed; screenshot for record.
- [ ] Step 4: Edit HANDOFF.md Problem 5 → resolved status: canonical = Documents\GitHub\Path; OneDrive copy retired; archive pending review.
- [ ] Step 5: Tell user: restart opencode session with cwd = C:\Users\van1h\Documents\GitHub\Path.

## Task 7: Retention review (only after Task 5 green)
- [ ] Step 1: archive diff for unique work: Set-Location archive; `git status -sb`; `git diff --stat`; categorize 291 dirty files vs archive HEAD 05195b8 and vs moved repo: (a) uniquely newer in archive, (b) identical/superseded, (c) stale. User decides keep/delete.
- [ ] Step 2: eyeball 122 .bak files: `Get-ChildItem -Recurse -Filter *.bak | Where-Object { $_.FullName -notmatch "node_modules" } | Select-Object FullName`; user decides which to keep; bulk-delete rest after approval. NEVER delete `.env*.bak` without checking for secrets.
- [ ] Step 3: stray scaffold `C:\Users\van1h\Documents\path` (0-commit git + .opencode + .superbased + eng.traineddata): present as likely-junk with evidence; delete only on user confirmation (`Remove-Item -Recurse -Force`).

## Task 8: Final gates
- [ ] Step 1: load verification-before-completion skill; re-run `node test-all.mjs` (green) + Task 4 Step 3 hash comparison; record output.
- [ ] Step 2: `python .disciplined-work\run_gate.py` → pass.
- [ ] Step 3: deliver summary: new canonical path · HEAD · ahead-count · test status · archive path · three lists (deleted/hard-locked/pending review) · restart reminder.
