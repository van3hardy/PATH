# Design: Real Gmail send for the approval-gated dispatch

- **Date:** 2026-08-08
- **Status:** Approved
- **Related:** `docs/path/gap-review.md` (§8 Two-way communications hub is ❌ — "No outbound transport anywhere")

## Problem

The recruiter pipeline drafts, evidence-checks, and approval-gates every outbound message, then stops. `scripts/path-dispatch.mjs` runs the full `evaluateDryRun()` gate and returns `READY_TO_DISPATCH`, but there is **no real send** — dispatch is dry-run only. `send_email` is already a YELLOW action in `path-safety/policy.mjs` gated on first-touch approval, and `plugins/gmail/index.mjs` already contains the OAuth token-refresh plumbing, but the only Gmail integration is **read-only ingest**.

This design adds the missing outbound transport: a real, approval-gated, auditable Gmail send behind the exact gate that already exists.

## Goals

- A user with a Gmail account and the existing OAuth credentials can send an **approved** recruiter packet for real — one command, no web UI change.
- The send is **twice-gated**: `evaluateDryRun()` still re-runs before every send, preserving the air-gapped human-review guarantee for `YELLOW` first-touch outreach.
- The receipt is **auditable and idempotent**: `dispatch_completed` is append-only to the dispatch ledger, so a retry cannot double-send for packets already dispatched and a failure state cannot leave a fake "sent".
- **Zero new package dependencies** — raw `fetch` inline, same as `plugins/gmail`.

## Non-Goals

- No attachments (CV PDF) in v1. The packet carries only `finalText`; mailing anything binary is a later step with its own MIME + size-limit design.
- No LinkedIn / telephone / fax transports. This design is email-only.
- No subject field on the packet — `action.opportunity` is the only source of the message subject.
- No changes to the web UI (`web/`), the audit ledger schema, `path-safety/*`, or any existing test.

## Architecture

### Modules

1. **`transports/gmail-send.mjs`** — new, pure transport, no state.
   - Exports `sendGmailMessage({ clientId, clientSecret, refreshToken, to, subject, body, fetchFn = globalThis.fetch })`.
   - Runs OAuth refresh (same flow as `plugins/gmail/index.mjs`: POST `/oauth2.googleapis.com/token` with the refresh grant) to get a bearer access token.
   - Assembles a RFC 5322 email with `To: {name} <{address}>`, `Subject: {subject}`, `MIME-Version: 1.0`, and the approved `body` as plain text.
   - Base64url-encodes the message and POSTs it to `https://gmail.googleapis.com/gmail/v1/users/me/messages/send` with `Authorization: Bearer`.
   - Returns `{ ok: true, messageId: <string> }` on 2xx; throws a `codedError` (`SEND_FAILED_OAUTH`, `SEND_FAILED_API`, `SEND_FAILED_HTTP`) with the HTTP body on any non-2xx.

2. **`scripts/path-dispatch.mjs`** — extended, existing piece.
   - Add `--send` mode alongside the existing mandatory `--dry-run` flag.
   - `--send` shares all the current input loading (packet / approvals / dispatches / audit paths) and the same `evaluateDryRun()` gate; it is the **same code-path guard**.
   - On `READY_TO_DISPATCH`, derives `subject = \`${role} @ ${company}\`` from `packet.action.opportunity`, loads `.env` (via `dotenv`), reads `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, calls `sendGmailMessage`, then appends `dispatch_completed` to the dispatch ledger.
   - `dispatch_completed` record shape:
     ```
     { packetId, event: "dispatch_completed", timestamp, messageId, providerId: "gmail" }
     ```
     It is appended **only after** `sendGmailMessage` returns `ok:true`. Deduped by `packetId` in the dry-run `BLOCKED_ALREADY_DISPATCHED` check.
   - On any send failure, prints `SEND_FAILED_*` and exits 1 without touching the ledger, so an operator can rerun safely.

### Data flow

```
packet.jsonl (outbox)
  → path-dispatch --send
  → load packet + approvals + dispatch ledger + audit ledger
  → evaluateDryRun()          [approval gate, integrity + expiry + F-02]
     └─ NOT_READY → block, exit 1
  → credential from .env
  → sendGmailMessage()        [oauth token → gmail API send]
     └─ ok:false → SEND_FAILED_*, exit 1, no ledger write
  → append dispatch_completed to data/path-dispatch.jsonl
  → exit 0
```

### Dispatch ledger

`data/path-dispatch.jsonl` was already referenced as "referenced-but-absent" in the gap review; this design creates it (one entry per completed send). It is the **only** place dispatch state lives. `dispatch_completed` is not a member of `EVENT_RULES` in `path-safety/audit-ledger.mjs` — by design the audit ledger stays approval-authority-only; dispatch receipts are append-only logs, not part of the hash chain.

### Failure codes (new, from `transports/gmail-send.mjs`)

- `SEND_FAILED_OAUTH` — token refresh rejected (bad credentials / network / rate-limit).
- `SEND_FAILED_API` — Gmail send returned 4xx/5xx regardless of reason.
- `SEND_FAILED_HTTP` — transport error (fetch rejected, DNS, TLS).

Existing gate codes (`BLOCKED_*`, `READY_TO_DISPATCH`) are unchanged, so existing `tests/path-safety/dispatch.test.mjs` assertions stay undisturbed.

## Data flow — safety properties

1. **Double-gate**: the real send only proceeds after `evaluateDryRun()` says `READY_TO_DISPATCH` in the same run that then sends. A send cannot happen "around" the approval gate; the code authority on approved-to-send is the same function the F-02 suite prototypes.
2. **Idempotency**: `dispatch_completed` being already present for a packetId causes `BLOCKED_ALREADY_DISPATCHED` — retry of a sent packet is refused at the gate long before network.
3. **Once-only logging**: the ledger record is written only after a confirmed 2xx & `messageId`, so the history says the *actual* `messageId`, not a claim.
4. **Failure surfaces as an explicit status**, not an ambiguous code, and never touches the ledger.

## Testing strategy

Follow `tests/path-safety/dispatch.test.mjs` conventions (`node:test`, temp dirs, `spawnSync`).

- **Unit (`tests/path-safety/gmail-send.test.mjs`):** inject a fake `fetchFn`.
  - happy path → 200, returns `{ ok: true, messageId }`, captures that the request was indeed `POST …/messages/send` with a valid bearer and base64url `raw`.
  - token refresh failure → `SEND_FAILED_OAUTH`.
  - API 403/429/500 → `SEND_FAILED_API` (assert no network retry).
  - `fetchFn` throws → `SEND_FAILED_HTTP`.
- **Integration (`tests/path-safety/dispatch-send.test.mjs`):** subprocess `path-dispatch.mjs --send`, fake transport via env injection or a fixture `fetchFn`-ish seam if the CLI must call the transport indirectly.
  - approved packet + fake send success → exit 0, ledger has `dispatch_completed` with `messageId`.
  - approved packet + fake send failure → exit 1, ledger unchanged, `SEND_FAILED_*` printed.
  - REJECTED packet → gate blocks before any transport call.
  - already dispatched packetId → `BLOCKED_ALREADY_DISPATCHED`.
  - no `--send`/no `--dry-run` → exit 2 (usage error).

The subprocess seam: for testability, `path-dispatch.mjs --send` should accept an env override like `PATH_SEND_TRANSPORT=fake` that routes to a fake transport inside the script (or a `--transport=file` target). This keeps the CLI real for production while letting integration tests exercise the full logic without spoofing OAuth.

## Config / env

- `.env` already exists; add a documented block for the three Gmail credentials (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`). These are reused verbatim by `transports/gmail-send.mjs`.
- `.env.example` also already exists — document the variables there as well.

## Risks & mitigation

- **Sending real mail in tests**: never against the real API — always against the fake transport seam (both test levels).
- **Scope creep** (SMTP, attachments, web UI): explicitly excluded; the CLI is the single entry point for v1.
- **Audit integrity**: `dispatch_completed` does not join the audit hash chain, but the ledger is *only* read by the boundary-aware `evaluateDryRun()` code that also reads the audit ledger — the security invariant (send only after a published approval) still holds server-side.

## Open questions

- (none — all resolved during brainstorming: transport=Gmail, integration=extend `path-dispatch.mjs`, subject=from opportunity, attachments=deferred, receipt=dispatch ledger only.)