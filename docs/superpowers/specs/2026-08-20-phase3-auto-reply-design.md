# Design: Phase 3.2 approval-gated email replies

Date: 2026-08-20

## Decision

Build the automatic local/fake reply path only. A Gmail inbox candidate may become a bounded `draft_email_reply` request, PATH Brain may draft the response, and the safety gate may queue a YELLOW approval packet. Nothing sends until Van separately approves the packet and runs the dispatch path.

## Inputs

- Scanner candidate: `message_id`, `from`, `subject`, `body_snippet`, `signal`, plus optional `thread_id`, `message_id_header`, `references`, and `in_reply_to`.
- Reply context: owner-approved `opportunity`, `requestApproval`, and `evidenceRefs`.

## Boundary

`path-workflows/recruiter/reply-request-builder.mjs` converts a candidate and approved context into `path.recruiter.request.v1` with:

- `objective: "draft_email_reply"`
- `promptVersion: "path-reply-v1"`
- `action: { type: "send_email", channel: "email", touch: "reply" }`
- bounded `replyContext` only: candidate id, original subject, body snippet, and optional thread headers.

Raw email bodies and arbitrary candidate fields do not cross the boundary.

## Workflow

`runRecruiterWorkflow` passes `replyContext` into `runBrain` only for reply requests. The existing claim report, audit ledger, outbox reconciliation, and HUMAN_REVIEW result remain the control plane.

## Dispatch

Thread metadata is carried inside the approval packet action and passed to Gmail transport only after the packet is approved and the dispatch gate returns `READY_TO_DISPATCH`. Fake-send remains the automated test path.

## No-auto-send rule

The reply runner (`scripts/path-reply-run.mjs`) drafts and queues only. It does not read Gmail credentials, does not call the Gmail send transport, and does not write a dispatch ledger.
