# Gmail Reply Scanner

The Gmail reply scanner (`gmail-scan-replies.mjs`) is a **read-only** Inbox scanner that turns recent employer replies into `data/reply-candidates.json` entries — closing the `#1583` gap documented in `paste-reply.mjs`'s header ("inbox scanner unbuilt"). It is a standalone root script, not a plugin: it is invoked directly by `node`, and its Inbox → `reply-candidates.json` feed is exactly what `reply-watch.mjs` (the classify/review loop) consumes. It reuses the same pure parsing helpers as the `gmail` ingest plugin and the same OAuth refresh pattern as `transports/gmail-send.mjs`, but makes no tracker mutations and never touches `data/applications.md`.

## Usage

```
node gmail-scan-replies.mjs [--days N] [--dry-run]
node gmail-scan-replies.mjs --help
```

Scans `in:inbox newer_than:Nd` (default `N = 7`), skips blocklisted job-alert senders and messages already present in `data/reply-candidates.json` or the shared `data/gmail-state.json` cursor, and appends the rest as reply-watch candidates (`signal` stays `null` — classification is `reply-watch.mjs`'s job, never this script's).

- `--days N` — look back N days (default 7; config `plugins.gmail-replies.days_back` overrides).
- `--dry-run` — lists what would be appended without writing anything (no candidates write, no state write).

## ENV variables

The same three `GMAIL_*` variables the `gmail` / `gmail-send` use. Credentials are read from `.env` (dotenv, optional) or ambient `process.env`:

| Env var | Purpose |
|---|---|
| `GMAIL_CLIENT_ID` | OAuth client id (used for the refresh-grant exchange) |
| `GMAIL_CLIENT_SECRET` | OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Long-lived refresh token, exchanged for a short-lived access token |

All three are required — the script exits non-zero with a clear message if any is missing.

## Config

`config/plugins.yml` → `plugins.gmail-replies` (the `gmail-replies` block in `plugins.example.yml` shows the shape). Both settings are optional:

```yaml
gmail-replies:
  enabled: false
  # days_back: 7            # overrides --days
  # blocklist_senders: []   # extra job-alert senders to skip (domains or addresses)
```

- `days_back` — integer; overrides the `--days` CLI flag when set on the config.
- `blocklist_senders` — domain or bare-address list; **additive** on top of the built-in defaults (e.g. `alerts.linkedin.com`). Domains match by suffix, so any sub-domain of a blocklist entry is skipped (e.g. `mail.alerts.example.com` matches entry `alerts.example.com`).

The block carries settings only — the script is invoked directly and never goes through the plugin engine's run lifecycle.

## Data flow

```
Gmail Inbox (in:inbox newer_than:Nd)
  → blocklist filter (built-in defaults ∪ config blocklist_senders)
  → append to data/reply-candidates.json     [candidate shape:]
                                              { message_id, from, subject, body_snippet, signal: null,
                                                thread_id?, message_id_header?, references?, in_reply_to? }
  → write processed ids to data/gmail-state.json (shared cursor)
```

- **`data/reply-candidates.json`** — the append-only feed `reply-watch.mjs` and `scripts/path-reply-run.mjs` consume. Written atomically (write-then-rename, same `appendCandidate` path `paste-reply.mjs` uses). Gmail thread metadata is preserved when Gmail provides it so an approved reply packet can dispatch with `threadId`, `In-Reply-To`, and `References` headers.
- **`data/gmail-state.json`** — a shared `processed_message_ids` cursor so re-runs skip what's already been handled, staying idempotent even if `reply-candidates.json` is pruned.

## Safety notes

- **No tracker writes.** The scanner imports no `tracker-*` module and never touches `data/applications.md` — the `HUMAN_REVIEW` guarantee is preserved end-to-end.
- **Read-only by construction.** The scanner only ever reads the Inbox; the only writes are the two data files above, and `--dry-run` touches neither.
- **No DMARC gate — by design.** Unlike `plugins/gmail` (which fails closed on DMARC-non-aligned senders), this scanner deliberately accepts everything in the window. Real employer replies often come from domains that aren't DMARC-aligned; rejecting them would silently starve the pipeline. The blocklist, `reply-watch`'s Noise classifier, and the human review prompt are the sorting layer instead.
- **Idempotent across runs.** Message ids are checked against both `data/reply-candidates.json` and the shared `data/gmail-state.json` cursor, so re-runs append nothing new. A single bad message fetch is skipped and logged, never fatal.

## Next step

Once the scanner has fed `reply-candidates.json`, run the classify loop:

```
node reply-watch.mjs
```

That reads the candidates, classifies signals (Noise / Not a match / Interview, etc.), and drives the review loop.

To draft an approval-gated email reply without sending mail, build a reply context JSON containing the owner-approved evidence refs and run:

```
node scripts/path-reply-run.mjs <candidate.json> <reply-context.json> <repo-or-sandbox-root>
```

This uses the fake PATH Brain provider by default, writes a HUMAN_REVIEW approval packet to the local outbox, and does not dispatch email.

Reference: [implementation plan](../superpowers/plans/2026-08-09-gmail-reply-scanner.md), [design spec](../superpowers/specs/2026-08-09-gmail-reply-scanner-design.md).
