# Path Approval Packets And Audit Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the minimal local safety records that describe YELLOW actions awaiting Van approval and append immutable JSONL audit entries.

**Architecture:** Keep packet construction and audit persistence as separate pure-ish modules under `path-safety/`. Packet construction reuses the existing policy classifier and approved-fact resolver; it never sends or submits. The ledger appends timestamped JSONL records and creates only the requested parent directory.

**Tech Stack:** Node.js 18+, JavaScript `.mjs`, built-in `node:test`, filesystem JSONL, existing Path safety modules.

## Global Constraints

- Path v1 is approval-required for all outbound communication.
- YELLOW actions must produce `AWAITING_VAN_APPROVAL` packets.
- RED actions remain blocked/manual-only and are not made sendable by this task.
- Claims must be classified through `resolveClaims` against Van-approved facts.
- No credentials, external writes, sends, submissions, or dependency installation.
- Behavior changes require a failing test before implementation and a fresh full focused test run afterward.

## Design Decision

The packet is a plain object containing identity, timestamp, tier, reasons, action, recipient, model/prompt provenance, supported claims, unsupported claims, and final text. Its ID is a short SHA-256 digest of the action, recipient, text, and creation timestamp. This preserves useful provenance without adding a database or dependency.

The audit ledger is append-only JSONL. `appendAuditRecord` adds an ISO timestamp, creates the target parent directory, appends one serialized record, and returns the exact entry written. Alternatives considered: SQLite would add persistence complexity and a dependency boundary; a single mutable JSON document would weaken append-only audit semantics. JSONL is the smallest local-first fit for this task.

## Task 1: Approval packet builder

**Files:**

- Create: `path-safety/approval-packet.mjs`
- Test: `tests/path-safety/approval-packet.test.mjs`

**Interface:** `buildApprovalPacket(input)` returns a packet with `tier`, `status`, `reasons`, recipient, provenance, claim results, and final text.

- [ ] Write the YELLOW packet test.
- [ ] Run it and confirm failure because the module is missing.
- [ ] Implement the smallest builder using `classifyAction` and `resolveClaims`.
- [ ] Run the test and confirm it passes.

## Task 2: Audit ledger

**Files:**

- Create: `path-safety/audit-ledger.mjs`
- Create: `data/.gitkeep`
- Test: `tests/path-safety/audit-ledger.test.mjs`

**Interface:** `appendAuditRecord(auditPath, record)` appends exactly one timestamped JSONL record and returns it.

- [ ] Write the JSONL/timestamp test using a temporary path.
- [ ] Run it and confirm failure because the module is missing.
- [ ] Implement append-only writing with parent-directory creation.
- [ ] Run the test and confirm it passes.

## Final verification

- [ ] Run `npm.cmd run test:path-safety`.
- [ ] Confirm the working tree contains only the intended Task 4 files and this plan.
- [ ] Request explicit approval before committing Task 4.
