# Plan: Phase 2 — Path Brain real provider (roadmap 2.1/2.2, gap #9)

Date: 2026-08-16

## Objective

Make subsystem #9 functional: a real Gemini provider replaces the hard-forced
`fake`/`none` in `path-run.mjs`; `fake`/`none` become explicit opt-in. The
model call routes through the capability gateway (`model.invoke`) bound to the
request's `requestApproval`, with capability receipts written to a dedicated
JSONL. Exit criterion: an evaluation runs through PATH Brain with a real
provider under YELLOW/GREEN approval rules, ending at HUMAN_REVIEW (YELLOW) or
a GREEN local action — nothing sends.

Design: `docs/superpowers/specs/2026-08-16-path-brain-provider-design.md`.

## Skills

- `gstack-setup-gbrain` — SKIPPED with documented variance (targets
  macOS/Claude Code; exit criterion doesn't need the knowledge graph).
- `brainstorming` ✅ · `da` ✅ (STANDARD CONDITIONAL) · `writing-plans` ✅.
- `subagent-driven-development` + `verification-before-completion` per task.

## Steps

### 1. Provider IDs + registry

- [ ] `path-brain/provider-ids.mjs`: `PROVIDER_IDS=['fake','none','gemini']`,
      `REAL_PROVIDER_IDS=['gemini']`, `DEFAULT_MODEL='gemini-3.6-flash'`.
- [ ] `path-brain/provider-registry.mjs`: `getProvider(id, opts)` with
      **dynamic** imports of `fake-provider.mjs` / `no-model-provider.mjs` /
      `gemini-provider.mjs`; unknown id → `BLOCKED_UNSUPPORTED_PROVIDER`.
- [ ] Tests `tests/path-brain/provider-registry.test.mjs`: frozen fake/none,
      gemini factory routing, unknown-id rejection, dynamic-import identity.
- [ ] `node --test tests/path-brain/provider-registry.test.mjs` green.

### 2. Gemini provider

- [ ] `path-brain/gemini-provider.mjs`: `createGeminiProvider({ transport,
      model, apiKey, approvalAuthority, approval, receiptSink, now, rootDir })`
      → frozen `{ generate }`; default REST transport via global `fetch`
      (`:generateContent`), lazy dotenv for `GEMINI_API_KEY`;
      `BLOCKED_NO_GEMINI_KEY` when missing on the real path.
- [ ] Anti-fabrication `applyClaimDiscipline`: claims filtered to evidence
      quotes (approved) whose normalized form appears in `text`; exact
      OUTPUT_KEYS; `disclosureIncluded: true` enforced.
- [ ] Gateway wrap: `model.invoke` intent (`actor:'system'`, resource
      `{type:'model',id:'gemini'}`, no destination), approval minted from
      `requestApproval` (`source:'human','approvedBy':'Van'`,
      `issuedAt=approvedAt`), `executeCapability` with
      `{ now, receiptSink, approvalAuthority }`; outcome hashes provider result.
- [ ] Error mapping: HTTP → `FAILED_BRAIN_PROVIDER`; timeout →
      `FAILED_BRAIN_TIMEOUT`.
- [ ] Tests `tests/path-brain/gemini-provider.test.mjs` (mock transport):
      OUTPUT_KEYS shape, claim discipline (lie dropped / SUPPORTED only),
      missing key, HTTP error, timeout, gateway ALLOW / REQUIRE_APPROVAL /
      receipts written + `verifyCapabilityReceipts`.
- [ ] `node --test tests/path-brain/gemini-provider.test.mjs` green.

### 3. Workflow timeout passthrough

- [ ] `path-workflows/recruiter/recruiter-workflow.mjs`: add
      `brainTimeoutMs` option (default 5000) threaded into `runBrain`.
- [ ] Existing workflow tests still green (default unchanged).
- [ ] `node --test tests/path-workflows/recruiter/recruiter-workflow.test.mjs` green.

### 4. request-boundary + audit-ledger relaxation

- [ ] `request-boundary.mjs` L76: widen provider check to `PROVIDER_IDS`.
- [ ] `audit-ledger.mjs` `hasValidAuditFacts`: add real-provider branch
      (REAL_PROVIDER_IDS member + non-empty model); keep fake+locked-model and
      diagnostic none/none; everything else still invalid.
- [ ] Tests: request-boundary `gemini` accepted / `remote` rejected;
      audit-ledger `gemini`+model valid, `gemini`+empty model invalid,
      `'arbitrary'` and packet `none`/`none` still rejected.
- [ ] `node --test tests/path-workflows/recruiter/request-boundary.test.mjs
      tests/path-safety/audit-ledger.test.mjs` green.

### 5. path-run.mjs wiring

- [ ] Remove hard-force (L43-46); resolve via registry.
- [ ] `gemini`: build approval authority + `model.invoke` approval bound to
      `requestApproval` + `createJsonlReceiptSink(rootDir/data/path-capability-receipts.jsonl)`;
      `fake`/`none` plain (no gateway artifacts).
- [ ] Pass `brainTimeoutMs` (60s) for real providers; keep 5000 for fake/none.
- [ ] Keep `--local-only`, HUMAN_REVIEW, unknown-id exit 2; NO `fetch(` /
      `node:https` in this file.
- [ ] Tests `tests/path-cli/path-run.test.mjs`: gemini request with stub
      provider runs; unknown id exit 2; CLI-source assertion still passes.
- [ ] `node --test tests/path-cli/path-run.test.mjs` green.

### 6. Workflow real-provider test

- [ ] `tests/path-workflows/recruiter/recruiter-workflow.test.mjs`: add
      real-provider-path test (registry + stub transport) → success, YELLOW
      queues HUMAN_REVIEW, GREEN local action allowed, audit carries
      `provider:'gemini'`.
- [ ] `node --test tests/path-workflows/recruiter/recruiter-workflow.test.mjs` green.

### 7. Docs + env

- [ ] `.env.example`: Gemini default model comment → `gemini-3.6-flash`;
      note PATH Brain reuses `GEMINI_API_KEY`.
- [ ] Confirm no `config/path.autonomy.yml` change needed.

### 8. Gates

- [ ] Full detached `node test-all.mjs` (expect ≥ 3472 + new tests passed,
      0 failed, 1 environmental warning).
- [ ] `node validate-system-paths-coverage.mjs` → OK.
- [ ] Tick roadmap 2.1 + 2.2 (✅ + date), gap-review #9 (✅).
- [ ] Surgical git commit (never `git add -A`; ~1041-file upstream drift
      excluded).

## Decisions (user-confirmed 2026-08-16)

- Gemini free tier, `gemini-3.6-flash` default; reuse `GEMINI_API_KEY`.
- `fake`/`none` stay explicit opt-in (registry), not deleted.
- Receipt sink at `data/path-capability-receipts.jsonl` — never mixed into
  `path-audit.jsonl`.
- No new plugins/MCP for model access.

## Exit criteria

- [ ] A gemini run passes through the gateway (`model.invoke` approval bound
      to `requestApproval`) with receipts written, ending at HUMAN_REVIEW or
      a GREEN action.
- [ ] `node test-all.mjs` green (≥ 3472 + new, 0 failed).
- [ ] `validate-system-paths-coverage.mjs` OK.
- [ ] Roadmap 2.1/2.2 + gap-review #9 ticked.
- [ ] Plan + design committed surgically.