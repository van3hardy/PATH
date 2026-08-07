# Path Capability Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Every behavior change follows red-green-refactor. No commits, installs, pushes, external writes, real browser sessions, model calls, or plugin network calls are authorized in this plan.

**Goal:** Put Path's existing tools, plugins, agent/model launches, browser operations, and resource access behind one fail-closed capability catalog and policy gateway with human approval and append-only, content-minimized receipts.

**Architecture:** `path-safety/capability-catalog.mjs` is the sole authoritative manifest of capability effects. `path-safety/capability-gateway.mjs` validates intents, binds approvals to an exact intent hash, returns `ALLOW`, `REQUIRE_APPROVAL`, or `DENY`, and wraps execution. `path-safety/capability-receipts.mjs` writes hash-chained JSONL receipts without raw prompts, CV text, form answers, environment values, or plugin payloads. Existing plugin, web action, model-launch, and browser chokepoints call this gateway; client confirmation is a UX preflight while server/Node enforcement remains authoritative.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, existing TypeScript/Next.js source, existing Path SHA-256/stable-JSON helpers. No new dependency.

## Global Constraints

- Preserve `ARCHITECTURE.md`: local-first, AI-agnostic, human-in-the-loop; canonical human-readable files remain primary and SQLite remains derived only.
- Preserve the source-of-truth boundary in `AGENTS.md`; receipts contain metadata and hashes only, never user claims or application answers.
- Preserve the no-auto-submit invariant. `browser.submit` and every unknown capability are denied with no override in this scope.
- Consequential effects are exactly `local_write`, `external_read`, `external_write`, `spend`, and `destructive`; `read` with local-only resources is non-consequential.
- Agent-originated consequential calls require a human-bound approval. A direct CLI or direct UI gesture is recorded as direct-user approval for that exact call.
- Approval binds `capabilityId`, actor, normalized metadata, resources, destinations, and expiry through `scopeHash`; stale or mismatched approval is rejected.
- Plugin invocation must execute only the selected plugin ID and selected hook. Provider plugins remain explicit-config-only and never auto-detect.
- Local model/CLI adapters remain supported; the gateway does not require OpenAI or any cloud provider.
- No code may submit an application, send recruiter outreach, install dependencies, create commits, push, deploy, or call real external services during verification.

---

### Task 1: Core catalog, policy decision, approval binding, and receipts

**Files:**
- Create: `path-safety/capability-catalog.mjs`
- Create: `path-safety/capability-gateway.mjs`
- Create: `path-safety/capability-receipts.mjs`
- Create: `tests/path-safety/capability-gateway.test.mjs`

**Interfaces:**
- `getCapability(capabilityId)` returns a frozen catalog entry or `null`.
- `pluginCapabilityId(pluginId, hook)` returns `plugin.<id>.<hook>` only for a valid plugin ID and declared hook.
- `buildCapabilityIntent({ capabilityId, actor, metadata, resources, approval })` returns a strict normalized intent.
- `evaluateCapability(intent, { now })` returns `{ decision, code, scopeHash, capability }` where decision is `ALLOW`, `REQUIRE_APPROVAL`, or `DENY`.
- `approveCapability(intent, { source, approvedBy, now, ttlMs })` returns an approval bound to `scopeHash`.
- `executeCapability(intent, operation, { now, receiptSink })` never calls `operation` unless the decision is `ALLOW`; it records attempted and terminal receipts.
- `createJsonlReceiptSink(receiptPath)` appends a hash-chained record after validating the existing chain.
- `verifyCapabilityReceipts(receiptPath)` proves schema, record hashes, and previous-hash continuity.

- [x] Write tests proving local reads are allowed; unknown capability, unknown fields, malformed resources, and `browser.submit` are denied.
- [x] Run `node --test tests/path-safety/capability-gateway.test.mjs`; expected failure is missing gateway modules.
- [x] Implement the frozen catalog, strict normalization, deterministic scope hash, approval validation, and fail-closed decision logic.
- [x] Add execution tests proving denied/unapproved operations are not called, approved operations run once, thrown errors produce failed receipts, and receipts contain no supplied secret/payload text.
- [x] Run the focused test and `npm.cmd run test:path-safety`; both must pass.

### Task 2: Selected-plugin execution through the gateway

**Files:**
- Modify: `plugins/_engine.mjs`
- Modify: `plugins.mjs`
- Modify: `plugins/_types.js`
- Modify: `test-all.mjs`
- Test: `tests/path-safety/capability-gateway.test.mjs`

**Interfaces:**
- `loadPlugin(id, kind, { root, dryRun })` loads exactly one enabled, integrity-approved plugin and returns its scoped context.
- `runHook(id, kind, payload, { root, dryRun, timeoutMs, approval, receiptSink })` invokes exactly that plugin and returns one result object.
- `mergeProviderPlugins` wraps each explicit provider fetch in `executeCapability` with configuration-bound direct-user approval metadata.

- [x] Add a regression fixture with two enabled `notify` plugins and assert selecting one never invokes the other.
- [x] Run the plugin-focused launcher; expected failure must show the second plugin ran or the old signature cannot target an ID.
- [x] Change `cmdRun` and `_engine.mjs` to pass and enforce the selected ID, construct the catalog intent, bind direct CLI approval, and emit a receipt.
- [x] Cover `ingest`, `search`, `export`, `notify`, timeout, dry-run, missing plugin, and provider fetch behavior without network calls.
- [x] Run `node test-all.mjs --only plugins`, focused gateway tests, and the full Path safety suite.

### Task 3: Assistant action confirmation from the shared catalog

**Files:**
- Modify: `web/src/app/actions/registry.ts`
- Create: `web/test-capability-actions.mjs`
- Modify: `web/package.json`

**Interfaces:**
- Every action references a catalog capability ID rather than declaring a private `sideEffect` label.
- `dispatch` returns `confirm` before executing every catalog capability whose effects are consequential.
- Only the closure stored by the UI can execute the approved action; model-supplied JSON cannot self-approve.

- [x] Add behavior tests proving evaluate/research/PDF/explore/apply/status/memory/profile/portals are not executed before confirmation while navigation/filtering remain immediate.
- [x] Run `node --test web/test-capability-actions.mjs`; expected failure identifies silent spend/external/write execution.
- [x] Implement catalog-driven confirmation and accurate summaries, removing `AUTO_FIRE_MAX` silent spend behavior.
- [x] Run both web test files and `node --experimental-strip-types --check web/src/app/actions/registry.ts`.

### Task 4: Authoritative web server gateway for models and browser operations

**Files:**
- Create: `web/src/lib/server/capability-gateway.mjs`
- Modify: `web/src/app/api/assistant/route.ts`
- Modify: `web/src/app/api/run/route.ts`
- Modify: `web/src/app/api/explore/ai/route.ts`
- Modify: `web/src/app/api/cv/ingest/route.ts`
- Modify: `web/src/app/api/apply/session/route.ts`
- Modify: `web/src/app/api/apply/prefill/route.ts`
- Modify: `web/src/app/api/apply/fill/route.ts`
- Modify: `web/src/app/api/apply/drive/route.ts`
- Test: `web/test-capability-server.mjs`

**Interfaces:**
- `authorizeWebCapability({ capabilityId, actor, approvalSource, metadata, resources }, options)` delegates to the root gateway and stores receipts below `.career-ops-web/capability-receipts.jsonl`.
- Routes reject `DENY` with HTTP 403 and `REQUIRE_APPROVAL` with HTTP 409 before resolving a CLI, spawning a process, launching Playwright, navigating, or filling.
- Model receipts record adapter ID and declared locality only; prompts and model output are excluded.
- Browser receipts record hostname, session ID hash, field count, and outcome only; URLs, answers, and CV contents are excluded.

- [x] Add route-independent server-adapter tests proving no handler runs without exact approval and no receipt leaks supplied prompt, answer, token, or CV text.
- [x] Run the test and observe the missing adapter failure.
- [x] Add gateway calls immediately before each spawn/browser chokepoint and terminal outcome recording.
- [x] Assert `browser.submit` remains absent/denied and `driveSession` cannot receive a submit action.
- [x] Run web tests plus Node TypeScript syntax checks for every modified route.

### Task 5: Documentation, workflow evidence, and whole-system verification

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `plugins/README.md`
- Modify: `docs/PLUGINS.md`
- Modify: `AGENTS.md`
- Modify: `.disciplined-work/state.json`
- Modify: `.disciplined-work/final-verification.md`

**Interfaces:**
- Documentation names the gateway as the enforcement boundary and states its limits: local malicious code is not sandboxed and direct local filesystem access can bypass an application-level gateway.
- Canonical state records this parent contract, five packets, exact hashes, fresh commands, direct evidence, independent review, and no unapproved side effects.

- [x] Document the capability model, approval semantics, receipt location/retention, plugin targeting, local/cloud adapter distinction, and bypass limitations.
- [x] Independently review every changed file and diff against this plan.
- [x] Run focused gateway/plugin/web suites, `npm.cmd run test:path-safety`, `npm.cmd run test:path-agent`, `node test-all.mjs --quick`, web syntax checks, and any available build/typecheck without installing.
- [x] Generate fresh hashes and update `.disciplined-work` evidence only from actual command output.
- [x] Run `python .disciplined-work/run_gate.py`; completion requires `VERIFY: PASS` plus a clean requirement-by-requirement audit. If dependency absence prevents typecheck/build, report that exact limitation and do not claim those checks passed.
