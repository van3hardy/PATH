# Plan: Phase 3.2 approval-gated email replies

Date: 2026-08-20

## Scope

Finish the local/fake Phase 3 reply path without live Gmail sending.

## Tasks

1. Add tests for reply request validation, malformed reply contexts, and bounded snippet handling.
2. Add `reply-request-builder.mjs` to convert scanner candidates into `draft_email_reply` requests.
3. Wire `runRecruiterWorkflow` so reply requests pass `replyContext` into PATH Brain.
4. Extend packet/audit validation to accept the fake reply prompt/model pair.
5. Pass `threadId`, `inReplyTo`, and `references` from approved reply packets into Gmail transport.
6. Add `scripts/path-reply-run.mjs` as a local/fake workflow entrypoint that queues HUMAN_REVIEW packets and never sends.
7. Verify with focused scanner, brain, workflow, safety, dispatch, and gate tests.

## Completion checks

- `node --test tests/path-workflows/recruiter/*.test.mjs`
- `node --test tests/path-brain/*.test.mjs`
- `node --test tests/path-safety/approval-packet.test.mjs tests/path-safety/outbound-gate.test.mjs tests/path-safety/dispatch.test.mjs tests/path-safety/dispatch-send.test.mjs tests/path-safety/gmail-send.test.mjs`
- `node --test tests/gmail-scan-replies.test.mjs`
- `node --test tests/e2e/reply-approval-dispatch.test.mjs`
- `python .disciplined-work/run_gate.py`

Live Gmail send remains a separate explicit-approval gate.
