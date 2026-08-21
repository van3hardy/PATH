# Project Path Phase 4 Deployment and Scheduling Design

## Goal

Provide a local-first, headless scheduler for discovery scans, follow-up cadence analysis, and reply-watch ingestion. Scheduled work may write local artifacts and review recommendations, but it must stop before every YELLOW or RED action.

## Decisions

- Windows Task Scheduler is the host deployment target.
- The scheduler has no new runtime dependency and runs from the canonical repository root.
- `scan` is local-write-only; `followup` and `reply_watch` are review-only.
- The scheduler never invokes Gmail send, `path-dispatch --send`, `submit_application`, `browser.submit`, or an unknown consequential command.
- Dry-run is side-effect free. Normal runs write only scheduler state, an append-only run log, and existing local review artifacts.
- Live task registration, live mail, credentials, commits, pushes, and external deployment remain explicit approval gates.

## Components

1. `scripts/path-scheduler-core.mjs` contains pure configuration validation, due-job selection, lock decisions, status calculation, and safety policy.
2. `scripts/path-scheduler.mjs` is the CLI adapter. It loads `config/path.schedule.yml`, executes approved local commands, records state/log events, and supports `--dry-run`, `--once`, `--job`, `--force`, and `--status`.
3. `reply-watch.mjs --no-apply --json` is the unattended classifier mode. It emits recommendations without prompting or changing tracker state.
4. `followup-cadence.mjs --json` emits the existing analysis object without sending or mutating tracker state.
5. `scripts/install-path-scheduler.ps1` prints the exact Windows Scheduled Task action with `-WhatIf`; registration and removal are host-level operations and remain approval-gated.

## State and safety

- State: `data/path-scheduler-state.json`.
- Log: `data/path-scheduler-runs.jsonl`.
- Lock: `.path-runtime/path-scheduler.lock` with an expiry timestamp.
- Every job event records `runId`, job, status, reason, start/end timestamps, and command.
- A stale lock may be reclaimed only after its TTL. A live lock causes a skipped event.
- Invalid config, missing command, unsafe command, and unknown job fail closed.

## Verification

Each packet uses a failing test first, then the smallest implementation. The final evidence consists of focused scheduler/reply/follow-up/safety tests, CLI dry-run and fake local runs, installer `-WhatIf`, the broad test launcher, and `python .disciplined-work\\run_gate.py`.
