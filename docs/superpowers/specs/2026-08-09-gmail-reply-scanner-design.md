# Design: Gmail inbox scanner feeding the reply-watch classification pipeline

- **Date:** 2026-08-09
- **Status:** Approved
- **Related:** `docs/path/gap-review.md` (§9 Conversation intelligence — feed is manual/pasted; `paste-reply.mjs` header documents `#1583 unbuilt`), `docs/superpowers/specs/2026-08-08-gmail-send-design.md` (the now-shipped outbound twin)

## Problem

The conversation-intelligence pipeline (`reply-watch.mjs` → classify → prompt → tracker update) is complete, but its only input is `data/reply-candidates.json`, which today is populated only by manual paste (`paste-reply.mjs`). `paste-reply.mjs` explicitly documents the missing piece: a Gmail inbox scanner (`#1583`, "unbuilt, requires OAuth inbox-read access"). Gmail OAuth read is already proven in `plugins/gmail/index.mjs` (read-only job-lead ingest), so the missing work is a scanner that turns inbox employer replies into reply-watch candidates.

## Goals

- One command turns recent Inbox messages into `data/reply-candidates.json` entries in the exact shape `reply-watch.mjs` consumes (`{ message_id, from, subject, body_snippet, signal }`).
- Scans the Inbox **minus a noise-sender blocklist** (job-alert feeds, auto-confirmations), letting `reply-watch.mjs`'s Noise classifier mop up anything that slips through.
- Idempotent across runs (no duplicate candidates, no re-fetch loops); safe (`--dry-run`); read-only w.r.t. the tracker.
- **No real tracker mutations from the scanner itself** — classification + `data/applications.md` updates stay in `reply-watch.mjs` behind its existing y/N prompt (preserves the §12 HUMAN_REVIEW guarantee).

## Non-Goals

- No sending. The scanner is read-only against Gmail.
- No attachments / MIME construction.
- No web UI changes.
- No changes to `plugins/gmail` itself (its job-lead ingest stays as-is; the reply scanner is a separate script that *imports* helpers from it).
- No DMARC fail-closed gate on replies (see Risks & mitigation).

## Architecture

### Files

1. **`gmail-scan-replies.mjs`** (new, repo root, sibling of `paste-reply.mjs` / `reply-watch.mjs`). No package deps; raw `fetch`. Composed of small units:
   - `getAccessToken({ clientId, clientSecret, refreshToken }, fetchFn = globalThis.fetch)` — copy of the existing OAuth refresh pattern (same shape as `transports/gmail-send.mjs`).
   - `buildListQuery({ days })` — builds the Gmail `q` string: `in:inbox newer_than:{n}d`.
   - `resolveBlocklist({ cfg })` → `Set<string>` — inline default sender domains + optional `config/plugins.yml` `plugins.gmail-replies.blocklist_senders` overlay.
   - `isBlocklisted(domain, blocklist)` → boolean.
   - `parseMessage({ id, detailPayload })` — detail shape → candidate `{ message_id, from, subject, body_snippet, signal: null }` via `getMessageBody` + `parseRoleAtCompany` from `plugins/gmail/_helpers.mjs`.
   - `scanReplies({ ..., write })` — orchestrator: list → paginate → per-message skip (candidates file has seen id / state cursor has id / blocklist sender) → detail → candidate → append; persists processed ids to `data/gmail-state.json`. Injects `write` (in `--dry-run` mode a no-op) so the whole flow is testable without the file system and without Gmail.
   - CLI `main()` — `node gmail-scan-replies.mjs [--days N] [--dry-run]`.

2. **`tests/gmail-scan-replies.test.mjs`** (new) — `node:test`/`assert` suite run by `test-all.mjs` (`.test.mjs` discovery), mirroring `tests/path-safety/gmail-send.test.mjs` conventions with injected `fetchFn`.

### Reuse

- `appendCandidate(candidate, candidatesPath)` — imported from `paste-reply.mjs` (atomic write-then-rename; creates the file if missing). This preserves the exact append contract `paste-reply` established for `data/reply-candidates.json`.
- `data/gmail-state.json` processed-message-id cursor — same file/format as `plugins/gmail` `STATE_PATH`, so both scanners share "already seen" state (won't re-fetch messages the job-lead ingest consumed), and the reply scanner's own seen-set is kept there too.
- `isAuthenticEmail`, `getMessageBody`, `parseRoleAtCompany`, `extractUrls`, `companyFromUrl` from `plugins/gmail/_helpers.mjs` (pure, already unit-tested implicitly through the plugin).

### Config (`config/plugins.yml`, optional)

```yaml
plugins:
  gmail-replies:
    days_back: 30            # override the --days default (7)
    blocklist_senders:
      - alerts.example.com   # extra sender domains to skip, additive to inline defaults
```

Read via the engine's `loadPluginConfig(root)` (fail-open to `{}` if absent/malformed) → `cfg.plugins?.['gmail-replies']`. Running the script directly is the opt-in — no `enabled` flag gates a standalone script.

### Env

Same three vars as dispatch send / gmail ingest, no new ones (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`). `.env.example` block already documents them.

## Data flow — safety properties

1. **Idempotent**: message id membership check against BOTH `data/reply-candidates.json` (`message_id`s already present) and the `data/gmail-state.json` cursor. Re-running scans nothing new, re-visits nothing.
2. **Per-message resilience**: a single bad detail fetch is skipped and logged, never fatal (same as `plugins/gmail` numbered loop).
3. **`--dry-run`** lists exactly what it would append, touching nothing (no candidates file write, no state write).
4. **No tracker mutation path**: the script imports no `tracker-*` module and never touches `data/applications.md`. The only dialog is the summary output.
5. **Fails soft on blocklist**: misconfigured / empty blocklist → nothing is excluded → replies still land in candidates and `reply-watch` sorts them. Real employer replies are never silently dropped by a config error.

## Supplied candidate shape

```json
{
  "message_id": "<gmail message id>",
  "from": "recruiter@example.com",
  "subject": "Interview invitation — Full-stack Engineer",
  "body_snippet": "Your first-round interview is…",
  "signal": null
}
```

`signal` stays `null` — classification (`Interview / Rejected / …`) is `reply-watch.mjs`'s job and derives from `subject` + `body_snippet`; the scanner explicitly does not classify (matching `paste-reply.mjs` rationale).

## Testing strategy

- **OAuth/query**: fake `fetchFn` asserting the token exchange URL + the list query (`in:inbox newer_than:7d`) and pagination through `nextPageToken`.
- **Skip logic**: given existing candidates with a seen id + a state cursor + a blocklisted sender, `scanReplies` skips all three and omits only what was already seen.
- **Blocklist resolution**: inline defaults + yaml override union; `isBlocklisted` domain normalization.
- **Shape**: a canned detail payload → candidate matches `{ message_id, from, subject, body_snippet }` and `signal: null`.
- **Dry-run**: orchestrator with `write: noop` performs no file or state writes.
- **Failure**: missing `GMAIL_*` env → exit non-zero with a clear message before any fetch.
- **No integration test against real Gmail** — same policy as dispatch-send.

## Risks & mitigation

- **DMARC fail-closed would starve real replies.** `plugins/gmail` uses `isAuthenticEmail` (dmarc=pass) to guard the job-lead ingest. Legitimate employer replies may lack a passing dmarc header (sender's domain often not DMARC-aligned). Decision: the reply scanner does **not** gate on DMARC; it accepts everything in the Inbox window, relies on the blocklist + `reply-watch`'s Noise classifier + the human review prompt. Note in code why.
- **Duplicated OAuth code**: three copies now live (plugin, send transport, scanner). Accepted — each is a focused, immutable, ~20-line function; extracting a shared auth helper is out of scope for this design.
- **Shared state cursor concurrency**: `plugins/gmail` and the scan can both write `data/gmail-state.json`. Both read-then-write with whole-file read/write on a small array; a lost update between them only means a re-scan of a handful of messages, deduped by the candidates file — no candidate duplication. Documented, not engineered away.

## Open questions

- (none — resolved during brainstorming: scope=Inbox minus blocklist; write=append into `reply-candidates.json`; dedupe=candidates file + shared state cursor; blocklist=config (`plugins.gmail-replies.blocklist_senders`); placement=standalone root script; DMARC=relaxed.)