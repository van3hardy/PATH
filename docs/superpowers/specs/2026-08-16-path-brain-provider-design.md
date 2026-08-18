# Design: Path Brain real provider (roadmap 2.1/2.2, gap #9)

Date: 2026-08-16

## Problem

Roadmap Phase 2 (docs/path/roadmap.md L69-79), gap-review #9:

> **2.1** Wire a real model provider into `path-brain/` (currently
> `fake-provider.mjs` + `no-model-provider.mjs` only).
> **2.2** Remove the hard-force in `path-run.mjs`; route through the
> approval/policy engine.
> **Exit criterion:** an evaluation runs through PATH Brain with a real
> provider under the YELLOW/GREEN approval rules; `fake`/`none` become
> explicit opt-in, not the default.

Today `scripts/path-run.mjs` hard-forces `provider` to `fake` or `none`
(L43-46: anything else → `BLOCKED_UNSUPPORTED_PROVIDER`, exit 2), so a real
run is impossible by construction. The `path-brain/` directory ships only the
two deterministic reference providers. The user's choice (confirmed in
brainstorming): **Gemini free tier** (`GEMINI_API_KEY` in `.env`, free tier
15 RPM / 1M tokens/day), model default `gemini-3.6-flash`.

## Constraints discovered during exploration

1. **Audit ledger locks provider/model.** `path-safety/audit-ledger.mjs` L22-23
   `LOCKED_PROVIDER='fake'` / `LOCKED_MODEL='deterministic-recruiter-template-v1'`;
   `hasValidAuditFacts` (~L113-114) accepts only `fake`+locked model OR a
   diagnostic event with `none`/`none`. A real run would hit
   `FAILED_AUDIT_SCHEMA` at the first `gateOutbound` audit write. **Must be
   relaxed** to accept real providers via an allowlist while keeping the two
   existing rejection tests green (`audit-ledger.test.mjs:173` `'arbitrary'`
   → `FAILED_AUDIT_SCHEMA`; `:178` `none`/`none` on a packet event →
   `FAILED_AUDIT_SCHEMA`).
2. **CLI source must not contain transport calls.** `path-run.test.mjs`
   (~L333-343) asserts `scripts/path-run.mjs` source contains no `fetch(` /
   `node:https` / `node:child_process` / transport / connector / browser
   imports. HTTP transport must live in `path-brain/gemini-provider.mjs`.
3. **Identity-replacement test needs dynamic import.** `path-run.test.mjs`
   (~L322) swaps `fake-provider.mjs` on disk and expects the run to detect the
   identity change → the registry must dynamically `import()` provider
   modules at runtime (never a static `import` of `fake-provider.mjs`).
4. **`executeCapability` requires a receipt sink.** `capability-gateway.mjs`
   `executeCapability` throws `INVALID_CAPABILITY_EXECUTION` without a
   `receiptSink`. DA's primary failure point — must wire
   `createJsonlReceiptSink` from `capability-receipts.mjs` or every real run
   fails.
5. **Model resource has no destination.** `normalizeResource` (gateway L63-78):
   a `model`-type resource must NOT carry a `destination` (only `external`
   may, and then it is required).
6. **`model.invoke` effect is `spend`, resource type `model`**
   (`capability-catalog.mjs`): `capability('model.invoke', ['spend'], ['model'])`,
   policy `approval`. `hasValidResourceScope` (gateway L159-161) requires a
   `model` resource for `spend`.
7. **Actor `system` may carry source `human`.** `approvalSourceAllowed`
   (gateway L143-147): `agent`→human only; `system`→`configuration` or
   `human`. So the model-call approval can be `source: 'human'`,
   `approvedBy: 'Van'`.
8. **Workflow calls `runBrain` without a timeout override.** `recruiter-workflow.mjs`
   L69-83 uses `runBrain(provider, input, { claimValidationMode:
   'claim-report' })`; `runBrain` default `timeoutMs: 5000`. A live Gemini
   call can exceed 5s → open design point: add `brainTimeoutMs` option on the
   workflow (default 5000, tests unchanged) and pass a larger value from
   `path-run.mjs` for real providers.
9. **`request-boundary.mjs` L76** validates `provider` against
   `['fake','none']` → must be widened to the registry allowlist.
10. **`runBrain` non-strict vs strict:** with `claimValidationMode:
    'claim-report'`, `runBrain` calls `validateOutput` (strict `OUTPUT_KEYS`
    shape) then `claim-report` verifies each claim verbatim in `text` (via
    `claim-report.mjs`). The provider MUST return exact OUTPUT_KEYS
    (`contract.mjs`): `schemaVersion`, `provider`, `model`, `promptVersion`,
    `voiceProfile`, `disclosurePolicy`, `disclosureIncluded`, `claims`,
    `text`.
11. **Anti-fabrication is a hard constraint.** `fact-resolver.mjs
    resolveClaims` requires each declared claim to be an **exact normalized
    match** of an approved evidence quote (`splitClaims` by sentence; approved
    quotes with `approved: true`); `claim-report.mjs` additionally requires
    each claim to appear verbatim (normalized) in `text`. Design keeps the
    model honest: the prompt treats evidence quotes + opportunity/recipient
    as **data**; post-processing sets `claims` = evidence quotes whose
    normalized form appears in the generated text → `SUPPORTED`, never
    fabricates. `disclosureIncluded: true` enforced (disclosure line from
    `recruiter-template.mjs`).

## Design

### 1. Provider IDs + registry (new files in `path-brain/`)

- **`path-brain/provider-ids.mjs`** — a pure constants module (no imports) so
  `path-safety/audit-ledger.mjs` and `request-boundary.mjs` can import it
  without an ESM cycle:
  - `PROVIDER_IDS = Object.freeze(['fake', 'none', 'gemini'])`
  - `REAL_PROVIDER_IDS = Object.freeze(['gemini'])`
  - `DEFAULT_MODEL = 'gemini-3.6-flash'` (current GA; `.env.example` default
    is stale `gemini-2.5-flash`, deprecated 2026-06-17).
- **`path-brain/provider-registry.mjs`** — `getProvider(id, opts)`:
  - `'fake'` / `'none'` → **dynamic** `import('./fake-provider.mjs')` /
    `import('./no-model-provider.mjs')` (honors the identity-replacement
    test).
  - `'gemini'` → dynamic `import('./gemini-provider.mjs')` then
    `createGeminiProvider(opts)`.
  - anything else → throw `BLOCKED_UNSUPPORTED_PROVIDER`.
  - Exposes `providerIds` (the allowlist) for consumers that don't want the
    full registry import.

### 2. `path-brain/gemini-provider.mjs` (new)

Factory `createGeminiProvider({ transport, model = DEFAULT_MODEL, apiKey,
approvalAuthority, approval, receiptSink, now, rootDir })` returning a frozen
provider with `async generate(input)`. Fully injectable for tests; the only
place in the system that performs HTTP.

- **Transport (injectable).** Default `transport = restTransport`: native
  `fetch` POST to
  `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`.
  Tests inject a stub that returns canned content blocks; the gateway wrap is
  bypassed or stubbed per test. `apiKey` default `process.env.GEMINI_API_KEY`
  (lazy dotenv load, mirroring `plugins/_engine.mjs loadDotenvOnce` L604-613);
  missing key + real transport → `BLOCKED_NO_GEMINI_KEY`.
- **Gateway wrap (2.2).** When `approval` + `receiptSink` + `approvalAuthority`
  are supplied, `generate` builds a `model.invoke` intent
  `{ capabilityId:'model.invoke', actor:'system', metadata:{ runId, provider,
  model, objective }, resources:[{ type:'model', id:'gemini' }] }`, mints the
  approval bound to the request's `requestApproval` (see §3), then
  `executeCapability` with `{ now, receiptSink, approvalAuthority }`
  (mirroring `plugins/_engine.mjs wrapProviderFetch` L879-907). The op's
  outcome hash covers the provider result. When no gateway params are given
  (unit tests), `generate` runs the transport directly — the registry/CLI is
  what wires the gateway.
- **Anti-fabrication post-processing.** `applyClaimDiscipline(evidence,
  opportunity, recipient, generatedText)`:
  1. Build `approvedFacts` = normalized approved quotes from
     `input.evidence` (`approved: true` only).
  2. Parse the model's JSON; if `claims` non-empty, **filter/replace** them:
     keep only claims whose normalized form is an exact match of an approved
     fact AND appears (normalized) in `text`; drop everything else.
  3. If the model omitted claims or produced none that pass, derive claims
     from approved facts whose normalized form appears in `text`.
  4. Force `disclosureIncluded: true` and ensure `text` contains the
     disclosure line if a disclosure segment is required.
  5. Return output with exact OUTPUT_KEYS; any missing/invalid key →
     `INVALID_BRAIN_OUTPUT` (handled by `runBrain`).
- **Prompt.** Rendered from `recruiter-template.mjs` + the request's
  evidence/opportunity/recipient as **data**, with an explicit instruction:
  *quote evidence verbatim, never invent facts, output strict JSON with the
  exact key set*. `voiceProfile` = the profile from the request template
  config.
- **Error mapping.** HTTP errors → `FAILED_BRAIN_PROVIDER` (coded, stable);
  transport timeouts → `FAILED_BRAIN_TIMEOUT`. Never swallows coded errors.

### 3. Approval routing (2.2)

- The request's `requestApproval` (principal `Van`, scope `THIS_REQUEST_ONLY`,
  validated by `request-boundary.mjs validateRequestApproval`) is the approval
  for the **outbound YELLOW/GREEN action** AND the **model call**, bound to
  the `model.invoke` scopeHash.
- `approveCapability(intent, { authority, source: 'human', approvedBy: 'Van',
  now: new Date(requestApproval.approvedAt), ttlMs: 24*60*60_000 })` — mints a
  gateway approval whose `issuedAt` is the request-approval timestamp, so the
  gateway's `REQUIRE_FRESH_APPROVAL` correctly rejects stale request approvals
  (`expiresAt = issuedAt + 24h`).
- **Receipt sink:** `createJsonlReceiptSink(path.join(rootDir, 'data',
  'path-capability-receipts.jsonl'))` — a **separate** JSONL from
  `path-audit.jsonl` (chain schema must not mix capability receipts with
  audit records). No `.career-ops-web/` dir exists; the project-local
  `data/` path is used (user layer, gitignored file list pattern).
- **YELLOW/GREEN outbound** is unchanged: `gateOutbound` still routes YELLOW
  `send_email` etc. to HUMAN_REVIEW packets; GREEN actions are local writes.
  The model-call gate is an *additional* `model.invoke` gate layered on top.

### 4. `scripts/path-run.mjs` changes

- **Remove the hard-force** (L43-46): `provider` now resolved via
  `getProvider(rawRequest.provider, { rootDir, requestApproval,
  approvalAuthority, now })` from the registry. Unknown ids still →
  `BLOCKED_UNSUPPORTED_PROVIDER` exit 2.
- **Wire the gateway for real providers only:** for `gemini`, construct the
  approval authority + `model.invoke` approval bound to `requestApproval` +
  `createJsonlReceiptSink`; `fake`/`none` stay plain (no gateway — their
  outputs are deterministic and their tests assert zero external ledger
  artifacts).
- **Timeout:** pass `brainTimeoutMs` (e.g. 60s) for real providers; keep 5000
  default in tests. Requires the small workflow option (constraint 8).
- **No transport calls** in this file (constraint 2) — only registry
  resolution + sink construction.

### 5. `path-workflows/recruiter/request-boundary.mjs`

L76: widen from `['fake','none']` to `PROVIDER_IDS` from
`path-brain/provider-ids.mjs`. `requestApproval` handling unchanged
(already required).

### 6. `path-safety/audit-ledger.mjs`

Relax `hasValidAuditFacts` (~L113-114) to:

- `fake` + `deterministic-recruiter-template-v1` → valid (unchanged);
- diagnostic event (`unsupported_claims_blocked`) + `none`/`none` → valid
  (unchanged);
- **any `REAL_PROVIDER_IDS` member + non-empty `model`** → valid (new);
- everything else → invalid (`FAILED_AUDIT_SCHEMA`).

Keeps both existing rejection tests green and lets real runs write
`green_action_allowed` / `action_approved` etc. audit records with
`provider: 'gemini'`, `model: 'gemini-3.6-flash'`.

### 7. `config/path.autonomy.yml` + `.env.example`

- `.env.example`: update Gemini default model comment to `gemini-3.6-flash`
  (stale `gemini-2.5-flash` deprecated) and note PATH Brain uses the same
  key. No new env vars required (reuse `GEMINI_API_KEY`/`GEMINI_MODEL`).
- `config/path.autonomy.yml` untouched — YELLOW/GREEN already configured.

## Test plan

- **New `tests/path-brain/provider-registry.test.mjs`:** registry returns
  frozen `fake`/`none` objects; `gemini` calls `createGeminiProvider` with
  injected transport; unknown id → `BLOCKED_UNSUPPORTED_PROVIDER`;
  dynamic-import identity honored (swap `fake-provider.mjs` via the same
  wrapper path-run tests use).
- **New `tests/path-brain/gemini-provider.test.mjs`:** mocked transport →
  (a) exact OUTPUT_KEYS shape, `disclosureIncluded: true`; (b) claims filtered
  to evidence quotes verbatim in text (lie → dropped, `SUPPORTED` only);
  (c) fabricated claim not in approved facts → dropped, never added to text;
  (d) missing apiKey + real transport → `BLOCKED_NO_GEMINI_KEY`;
  (e) transport HTTP error → `FAILED_BRAIN_PROVIDER`; (f) timeout →
  `FAILED_BRAIN_TIMEOUT`; (g) gateway wrap: valid `model.invoke` approval →
  `ALLOW`, stale/missing approval → `REQUIRE_APPROVAL`, and receipt JSONL
  written to the sink (temp dir, `verifyCapabilityReceipts` passes).
- **`tests/path-safety/audit-ledger.test.mjs`:** add cases — `gemini` +
  non-empty model valid; `gemini` + empty model invalid; keep `'arbitrary'`
  and packet-event `none`/`none` rejections.
- **`tests/path-workflows/recruiter/request-boundary.test.mjs`:** `gemini`
  accepted; `remote` still rejected.
- **`tests/path-workflows/recruiter/recruiter-workflow.test.mjs`:** add a
  real-provider-path test using a stub `gemini` provider (via registry with
  injected transport) → run succeeds, packet queued (YELLOW) or GREEN
  actions allowed, audit records carry `provider: 'gemini'`.
- **`tests/path-cli/path-run.test.mjs`:** `provider: 'gemini'` request with a
  mocked provider resolves and runs; unknown id still exit 2; the CLI-source
  no-`fetch(` assertion still passes (transport stays in path-brain).
- Full suite: `node test-all.mjs` green (baseline 3472 passed / 0 failed /
  1 environmental warning).
- `validate-system-paths-coverage.mjs` stays OK (new `path-brain/*.mjs` are
  under the already-registered `path-brain/` directory).

## Non-goals

- No auto-submit: the exit criterion is a run that ends at HUMAN_REVIEW /
  GREEN local action — nothing sends without the user.
- No new model providers beyond Gemini (OpenRouter etc. are out of scope;
  the registry allowlist is the extension point).
- No change to YELLOW/GREEN/RED policy semantics, `config/path.autonomy.yml`,
  or `approval-packet.mjs`.
- No new MCP servers or plugins for model access.

## Rollout

Design → plan doc (`docs/superpowers/plans/2026-08-16-phase2-path-brain.md`)
→ registry + provider (tests first) → gateway wiring in path-run →
request-boundary + audit-ledger relaxation → workflow timeout option →
CLI tests → `.env.example` + docs → full `test-all.mjs` gate →
`validate-system-paths-coverage` → tick roadmap 2.1/2.2 + gap-review #9 →
surgical git commit.