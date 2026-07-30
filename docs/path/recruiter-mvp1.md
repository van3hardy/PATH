# Path Recruiter MVP-1

Status: APPROVED DESIGN — IMPLEMENTATION STATE RECORDED SEPARATELY
Owner: Van
Design source SHA-256: DD8CF46A362ABA97A597A87F26ED8FB9F1E45892F1A3D74937654A9AC53AA75F

This specification does not authorize commits, pushes, models, connectors,
credentials, external actions, deployment, scheduling, or indexing.

## Approved MVP contract

Path Recruiter MVP-1 is a single-principal, local recruiter workflow. One
manual foreground Node command processes one Van-supplied request, uses only
approved evidence, creates a factual draft, claim report, and integrity-bound
YELLOW review packet, then stops at `HUMAN_REVIEW`. The review-ready result is
`LOCAL_REVIEW_READY`; it is not success, sending, dispatch, approval, or
submission. No success result exists before a separate human decision.

MVP-1 has no real model, connector, transport, email, LinkedIn, application
submission, browser mutation, credential use, background service, scheduler,
cloud deployment, SQLite authority, or external action. Design approval does
not authorize implementation or any side effect.

## Exact local outputs

One bounded run directory contains:

```text
data/path-runs/<run-id>/request.json
data/path-runs/<run-id>/evidence-selection.json
data/path-runs/<run-id>/draft.md
data/path-runs/<run-id>/claim-report.json
data/path-runs/<run-id>/events.jsonl
data/path-runs/<run-id>/run-state.json
data/path-runs/<run-id>/run-summary.md
```

The run appends the appropriate records to:

```text
data/path-outbox.jsonl
data/path-audit.jsonl
```

The terminal state for a reviewable local packet is `HUMAN_REVIEW` and its
result is `LOCAL_REVIEW_READY`. The process stops at human review before every
external action.

## Component contracts

### Request boundary

Input is one Van-supplied request. A reviewable packet requires a valid schema
version, run ID, created timestamp, objective, action, recipient, opportunity,
prompt version, `voiceProfile`, `disclosurePolicy`, provider, request approval,
and evidence references. Recipient name and address and opportunity company and
role are required and nonempty. Missing or unknown recipient or opportunity
returns `BLOCKED_INVALID_REQUEST` before evidence selection or Brain work.

`requestApproval` is required and must contain exactly
`principal: 'Van'`, `approvedAt: <ISO-8601 timestamp>`, and
`scope: 'THIS_REQUEST_ONLY'`. It is non-reusable and controls only that one
request; it does not authorize a later request, packet, decision, or side
effect. Manual CLI invocation plus the literal principal approval record is the
MVP trust boundary; it is not cryptographic identity proof.

The packet uses `voiceProfile:
path-recruiter-persistent-respectful-v1` and `disclosurePolicy:
always-disclose-ai-assistance-v1`. The AI-assistance disclosure is always
included; it is not optional or destination-dependent.

### Evidence selector and approval contract

The selector accepts only the explicit approved User Layer read allowlist and
returns `evidence-selection.json`. Location in an approved folder alone is not
approval. Every selected fact requires a stable source ID and fact key, source
path, `sourceType: 'USER_LAYER_FACT'`, source hash/version, exact atomic quote,
`OWNER_APPROVED_FACT` authority, `approvedBy: Van`, approval time,
`factRecordedAt`, freshness metadata, and `supersedesFactIds`.

Every request evidence reference requires `expectedSourceSha256`, captured at
request approval. Selected source bytes must SHA-256 match that
`expectedSourceSha256` or the run blocks. Explicit `supersedesFactIds` control
conflict resolution; conflicts not resolved by those IDs remain `UNRESOLVED`.

The selector records inspection time, source modified time, source SHA-256,
freshness mode (`STATIC` or `CURRENT` with `validUntil`), and supersession
relationships. Missing approval metadata, unreadable or outside-root evidence,
path traversal, symlink escape, or stale evidence blocks. Conflicting evidence
remains `UNRESOLVED`; a superseded fact cannot silently control a draft.
Approved user files remain canonical. A facts index is derived, retains
provenance, and cannot become a second authority.

### Brain adapter

The Brain receives only the validated request, selected evidence, prompt
version, output schema, recipient, opportunity, voice/disclosure IDs, and the
deterministic provider boundary. It has no filesystem, memory, tool, connector,
browser, shell, approval, or transport access. The first provider is
deterministic fake/no-model only. Provider absence, timeout, malformed output,
refusal, or version mismatch produces an explicit terminal failure; no provider
or model fallback is permitted.

The deterministic complete template uses the fixed respectful recruiter voice,
identifies Path as Van's AI recruiting assistant, always includes the
AI-assistance disclosure, and inserts only selected atomic factual sentences.
Any Ollama or OpenAI activation is a later, separately approved action.

### Claim resolver

The resolver evaluates the Brain's declared claims, not an inferred subset. It
produces `claim-report.json` with draft SHA-256, every atomic declared claim,
supported claims, unsupported claims, evidence IDs, and a deterministic status.
Every declared claim must be one atomic sentence with exact selected evidence.
The complete deterministic template and declarations are checked before packet
construction. Any unsupported claim returns
`BLOCKED_UNSUPPORTED_CLAIMS` before the outbound gate, packet, outbox, or
dispatch path.

Every declared claim must also appear verbatim in the draft text, compared after
trimming, collapsing whitespace runs, and lowercasing. A declaration absent from
the draft is `FAILED_BRAIN_OUTPUT_INVALID`.

Sentences the template supplies outside the declared claims — the greeting, the
interpolated role and company, the closing question, the signature, and the
AI-assistance disclosure — are not claim-checked. `unsupportedClaims: []` means
every declared claim resolved to approved evidence; it is not a statement about
unchecked template text.

Unsupported claims are distinct from RED. They are never packetized, manual,
promotable, approved, or dispatched.

### Policy and approval packet

The existing `path-safety` kernel receives the action, opportunity context,
recipient and channel, exact final text, declared claims, derived facts for
those claims, evidence IDs and hashes, claim-report hash, voice/disclosure IDs,
prompt version, provider/model, and policy version. It returns a GREEN internal
artifact, a YELLOW review packet, or a RED/BLOCKED result. Unknown action,
malformed policy, missing audit append, or ambiguous classification blocks.

The YELLOW packet binds action, recipient and channel, opportunity, exact draft
and text hash, source IDs and hashes, claim-report hash, voice profile,
disclosure policy and inclusion, prompt/provider/model versions, policy version,
creation time, expiry, decision state, idempotency key, and integrity hash.
`expiresAt` is exactly `createdAt + 24 hours`. `integritySha256` is the
deterministic SHA-256 of the canonical bound payload; packet `id` is the first
16 characters of `integritySha256`. `idempotencyKey` is exactly the first 24
lowercase-hex characters of SHA-256 over the canonical object containing
`action`, `recipient`, and exact `finalText`, without timestamps. Recalculation,
recomputation mismatch, expiry, duplicate, replay, or missing decision blocks
all progression. MVP-1 has no dispatcher capable of external delivery.

### Audit, queue reconciliation, and run state

The Runner writes every lifecycle transition to `events.jsonl`, records
artifact hashes and terminal status in `run-state.json`, and writes
`run-summary.md`. Audit append or terminal-state write failure is a run failure.
Partial writes use temporary-file plus atomic-replace handling where supported.

The audit JSONL ledger is append-only by application behavior and hash-chained
for local tamper evidence. It is explicitly NOT immutable: an actor with
filesystem write access can truncate or recompute it. Internal chain/schema
verification proves only consistency of the inspected bytes.

Queue attempt, queue success, and queue failure are separate recorded events;
queue/audit reconciliation is required before terminal `HUMAN_REVIEW`. Each
queue-related audit record binds the exact draft, source IDs and hashes,
recipient/channel, voice/disclosure IDs and inclusion, provider/model, prompt
and policy versions, decision/result, previous hash, and record hash.

## Permission policy

### GREEN — automatic local processing

- Request validation and bounded approved-evidence reading.
- Local deterministic drafting, claim resolution, tracking, and summary
  generation using approved inputs.
- Creation of an integrity-bound YELLOW review packet.

### YELLOW — exact human approval required

- Every first-touch email or LinkedIn message.
- Every reply and follow-up.
- Every application submission.
- Any later transport activation or external write.

### RED — manual only and not promotable in MVP-1

- Compensation numbers or negotiation.
- Accepting, declining, or countering offers.
- Legal statements, availability promises, or binding commitments.
- Unknown actions or destinations.

Persistent, thorough discovery and disciplined follow-up never permit spam,
harassment, fabricated facts, deceptive impersonation, policy evasion, or
noncompliant collection.

## Failure states and human-review stop

The run-state lifecycle is `CREATED`, `VALIDATED`, `EVIDENCE_SELECTED`,
`DRAFTED`, `CLAIMS_VERIFIED`, `PACKET_QUEUED`, and terminal `HUMAN_REVIEW`, or
terminal `FAILED`, `BLOCKED`, or `UNRESOLVED`. A reviewable result is exactly
`LOCAL_REVIEW_READY` at `HUMAN_REVIEW`. State transitions outside this graph
block. There is no automatic retry or fallback.

`BLOCKED_UNSUPPORTED_CLAIMS` stops before packet creation. RED content fails
closed and cannot be promoted by approval. Stale evidence blocks; conflicting
evidence remains unresolved. Every outbound action stays YELLOW until a
separate human review of the exact bound packet.

## Completion contract

MVP-1 is complete only when fresh evidence proves that the approved input and
every exact output validate; every material declared claim traces to current,
owner-approved evidence; unsupported and RED content fail closed; the run
records events, review-ready state, hash-chained audit records, and queue
reconciliation; the run reaches `HUMAN_REVIEW` with `LOCAL_REVIEW_READY` and
stops before external action; and focused tests, the relevant full suite,
independent review, requirements mapping, and working-tree inspection all pass.
Until then, the correct status is `NOT COMPLETE`.
