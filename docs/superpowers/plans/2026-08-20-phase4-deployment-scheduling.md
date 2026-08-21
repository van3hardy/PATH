# Project Path Phase 4 Deployment and Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a local-first scheduled Path run that produces local scan/review artifacts while fail-closed blocking outbound consequences.

**Architecture:** A pure scheduler core validates config, computes due jobs, owns the local lock, and classifies commands. A thin CLI executes only approved local commands and records JSON state/logs. Existing reply-watch and follow-up tools gain machine-readable, noninteractive modes; a PowerShell installer exposes a dry-run Task Scheduler deployment path.

**Tech Stack:** Node.js ESM, built-in `node:test`, YAML via existing `js-yaml`, PowerShell Task Scheduler cmdlets, local JSON/JSONL state.

**Spec:** `docs/superpowers/specs/2026-08-20-phase4-deployment-scheduling-design.md`

## Global Constraints

- No new runtime dependency.
- No automatic Gmail send, application submission, external account mutation, live credentials, commit, push, or deployment.
- YELLOW/RED work stops at HUMAN_REVIEW or BLOCKED.
- Preserve unrelated dirty-worktree changes.
- Run `.disciplined-work/run_gate.py` before any completion claim.

### Task 1: Scheduler core

**Files:** Create `scripts/path-scheduler-core.mjs`; create `tests/path-scheduler-core.test.mjs`; create `config/path.schedule.yml`.

- [ ] Write tests for config validation, due-job calculation, disabled jobs, lock expiry, and unsafe command rejection.
- [ ] Run the focused test and observe the expected missing-module failure.
- [ ] Implement pure helpers `validateSchedule`, `getDueJobs`, `evaluateLock`, `classifyCommand`, and `buildEvent`.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Scheduler CLI

**Files:** Create `scripts/path-scheduler.mjs`; create `tests/path-scheduler-cli.test.mjs`; modify `package.json` only to add `path:scheduler`.

- [ ] Write tests for dry-run side-effect freedom, once execution, forced named jobs, status output, and blocked commands.
- [ ] Run tests red.
- [ ] Implement the CLI using the core and injectable root/config/state/command runner options for tests.
- [ ] Run focused tests green.

### Task 3: Reply-watch unattended mode

**Files:** Modify `reply-watch.mjs`; create `tests/reply-watch-cli.test.mjs`.

- [ ] Write a fixture test proving `--no-apply --json` never prompts or changes the tracker and returns structured recommendations.
- [ ] Run red.
- [ ] Add flag parsing and a JSON-only output path while preserving interactive default behavior.
- [ ] Run focused tests green.

### Task 4: Follow-up JSON contract

**Files:** Modify `followup-cadence.mjs`; create `tests/followup-cadence-cli.test.mjs`.

- [ ] Write a test proving `--json` emits parseable analysis and performs no tracker write.
- [ ] Run red.
- [ ] Add explicit `--json` handling and reject unknown flags without changing default output compatibility.
- [ ] Run focused tests green.

### Task 5: Windows install dry-run

**Files:** Create `scripts/install-path-scheduler.ps1`; create `tests/install-path-scheduler.test.mjs`; create `docs/path/phase-4-deployment.md`.

- [ ] Write a test for the script's `-WhatIf` text and no-registration behavior.
- [ ] Run red.
- [ ] Implement install/uninstall preview and approval-gated registration.
- [ ] Run focused tests green and execute the actual `-WhatIf` command.

### Task 6: Safety and end-to-end verification

**Files:** Create `tests/path-scheduler-e2e.test.mjs`; modify `docs/path/roadmap.md`; modify `HANDOFF.md`; create `.disciplined-work/phase4-state.json` and evidence transcripts.

- [ ] Write the fake scheduled scan/follow-up/reply-watch flow and idempotency tests.
- [ ] Run red.
- [ ] Implement only the missing integration glue.
- [ ] Run focused suites, broad Path suites, CLI dry-run, installer `-WhatIf`, and the disciplined-work gate.
- [ ] Update roadmap and handoff from fresh evidence; leave live registration and live Gmail explicitly pending.
