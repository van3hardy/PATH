# Phase 4 Deployment and Scheduling Runbook

Phase 4 runs Path locally on a schedule. It performs discovery, cadence analysis, and reply ingestion without sending mail or submitting applications. Anything classified as YELLOW or RED remains a local review item.

## Run once

From `C:\Users\van1h\Documents\GitHub\Path`:

```powershell
node scripts\path-scheduler.mjs --once
node scripts\path-scheduler.mjs --once --job followup --force
```

The scheduler writes `data/path-scheduler-state.json` and appends events to `data/path-scheduler-runs.jsonl`. A local lock at `.path-runtime/path-scheduler.lock` prevents overlapping runs.

## Inspect without running

```powershell
node scripts\path-scheduler.mjs --dry-run
node scripts\path-scheduler.mjs --status
```

Dry-run never writes scheduler state or logs. Status reports the last event, per-job completion timestamps, and any active lock.

## Review-only tools

```powershell
node followup-cadence.mjs --json
node reply-watch.mjs --no-apply --json
```

The reply-watch unattended mode never prompts and never updates `data/applications.md`. The follow-up JSON mode never sends a message or changes tracker state.

## Windows Task Scheduler

Preview installation and removal first:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-path-scheduler.ps1 -WhatIf
powershell -ExecutionPolicy Bypass -File scripts\install-path-scheduler.ps1 -Uninstall -WhatIf
```

The preview shows the task name, interval, Node action, working directory, and log directory. Actual registration is a host-level side effect and requires explicit approval. If approved, register with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-path-scheduler.ps1 -TaskName "Path Phase 4 Scheduler" -EveryMinutes 60
```

The task uses the current Windows user with limited privileges and stores no Gmail credentials. Uninstalling requires the same explicit approval:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-path-scheduler.ps1 -Uninstall -TaskName "Path Phase 4 Scheduler"
```

## Safety boundary

The scheduler rejects `path-dispatch --send`, direct Gmail transport, `submit_application`, `browser.submit`, and unknown commands. It does not call the Gmail connector. Live Gmail dispatch and external submission remain separate approval-gated operations.
