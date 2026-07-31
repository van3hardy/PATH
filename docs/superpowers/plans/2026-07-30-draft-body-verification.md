# Draft-Body Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify every segment of the recruiter draft by its source and report the result, so `unsupportedClaims: []` can no longer imply a draft nobody checked.

**Architecture:** A new pure module `draft-classifier.mjs` splits `finalText` into segments and labels each `EVIDENCE`, `REQUEST`, `TEMPLATE`, or `UNVERIFIED`. `buildClaimReport` embeds the result in `claim-report.json`, which is already hashed into the approval packet. `renderRunSummary` surfaces unverified segments to the human reviewer. The classification never blocks; the existing `BLOCKED_UNSUPPORTED_CLAIMS` hard block is untouched.

**Tech Stack:** Node 24 ESM, `node:test`, `node:assert/strict`. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-draft-body-verification-design.md`.
- Branch: `path/bootstrap`. All paths below are relative to the repo root.
- No new npm dependencies. Node built-ins only.
- "Segment" means a chunk returned by `splitClaims` (`path-safety/fact-resolver.mjs:61`), not a linguistic sentence.
- Normalisation is trim, collapse whitespace runs, lowercase — matching `fact-resolver.mjs:68`.
- `classifyDraft` never throws for `UNVERIFIED` content. It throws only on malformed input, with code `FAILED_DRAFT_CLASSIFICATION`.
- Reviewer-facing wording is "accounted for", never "verified".
- Windows skips six symlink tests in `test:path-agent` with `EPERM`. Final verification must run on Linux via Docker:
  ```
  docker run --rm -v "<export-dir>:/app" -w /app node:24 sh -c "npm install --ignore-scripts >/dev/null 2>&1; npm run test:path-agent"
  ```
- Do not modify `path-safety/` in this plan.

---

### Task 1: Export template frames without changing rendered output

`recruiter-template.mjs` builds the draft from one template literal. The classifier must recognise those fixed parts. Copying them into a second file guarantees drift, so the template becomes the single source and exports its frames. The rendered text must stay byte-identical.

**Files:**
- Modify: `path-brain/recruiter-template.mjs:47-57`
- Test: `tests/path-brain/fake-provider.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `renderRequestFrame({ recipient, opportunity }) -> string`
  - `TEMPLATE_SEGMENTS: readonly string[]` (frozen, length 2)

- [ ] **Step 1: Write the failing test**

Append to `tests/path-brain/fake-provider.test.mjs`:

```js
import {
  renderRequestFrame,
  TEMPLATE_SEGMENTS
} from '../../path-brain/recruiter-template.mjs';

test('template exports the request frame and fixed segments it renders with', () => {
  const frame = renderRequestFrame({
    recipient: { name: 'Hiring Manager' },
    opportunity: { company: 'Example Company', role: 'AI Engineer' }
  });
  assert.equal(
    frame,
    "Hello Hiring Manager,\n\nI'm reaching out on Van's behalf about the AI Engineer opportunity at Example Company."
  );
  assert.deepEqual(TEMPLATE_SEGMENTS, [
    'If this background may be relevant, would you be open to a conversation?',
    "Best,\nVan\nPrepared with Path, Van's AI recruiting assistant."
  ]);
  assert.ok(Object.isFrozen(TEMPLATE_SEGMENTS));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/path-brain/fake-provider.test.mjs`
Expected: FAIL — `renderRequestFrame` is not exported.

- [ ] **Step 3: Restructure the template**

In `path-brain/recruiter-template.mjs`, add above `renderRecruiterTemplate`:

```js
export const TEMPLATE_SEGMENTS = Object.freeze([
  'If this background may be relevant, would you be open to a conversation?',
  "Best,\nVan\nPrepared with Path, Van's AI recruiting assistant."
]);

export function renderRequestFrame({ recipient, opportunity }) {
  return `Hello ${recipient.name},

I'm reaching out on Van's behalf about the ${opportunity.role} opportunity at ${opportunity.company}.`;
}
```

Replace the `const text = ...` literal (lines 47-57) with:

```js
  const text = [
    renderRequestFrame(input),
    claims.join('\n\n'),
    ...TEMPLATE_SEGMENTS
  ].join('\n\n');
```

- [ ] **Step 4: Run the full brain and CLI suites to prove output is unchanged**

Run: `node --test tests/path-brain/*.test.mjs tests/path-cli/*.test.mjs`
Expected: PASS. `tests/path-cli/path-run.test.mjs` asserts draft content end-to-end, so any byte change surfaces here.

- [ ] **Step 5: Commit**

```bash
git add path-brain/recruiter-template.mjs tests/path-brain/fake-provider.test.mjs
git commit -m "Export template frames from the recruiter template"
```

---

### Task 2: Add the pure draft classifier

**Files:**
- Create: `path-workflows/recruiter/draft-classifier.mjs`
- Test: `tests/path-workflows/recruiter/draft-classifier.test.mjs`

**Interfaces:**
- Consumes: `renderRequestFrame`, `TEMPLATE_SEGMENTS` (Task 1); `splitClaims` from `path-safety/fact-resolver.mjs`.
- Produces:
  ```
  classifyDraft({ text, evidenceItems, request }) -> {
    segments: [{ text: string, label: string, evidenceId?: string }],
    counts: { EVIDENCE: number, REQUEST: number, TEMPLATE: number, UNVERIFIED: number },
    unverified: string[]
  }
  ```
  `evidenceItems` is `selection.items` — objects with `id` and `quote`.
  `request` needs `recipient.name`, `opportunity.company`, `opportunity.role`.

- [ ] **Step 1: Write the failing tests**

Create `tests/path-workflows/recruiter/draft-classifier.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDraft } from '../../../path-workflows/recruiter/draft-classifier.mjs';
import { renderRecruiterTemplate } from '../../../path-brain/recruiter-template.mjs';

const CLAIM = 'Van builds agent workflows on Windows 11 with PowerShell.';

function request() {
  return {
    recipient: { name: 'Hiring Manager' },
    opportunity: { company: 'Example Company', role: 'AI Engineer' }
  };
}

function evidenceItems() {
  return [{ id: 'fact-agent-workflows', quote: CLAIM }];
}

function templateDraft() {
  return renderRecruiterTemplate({
    schemaVersion: 'path.brain.request.v1',
    promptVersion: 'path-recruiter-v1',
    objective: 'draft_first_touch',
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    ...request(),
    evidence: [{
      id: 'fact-agent-workflows',
      factKey: 'capability.agent-workflows',
      source: 'cv.md',
      quote: CLAIM
    }]
  }).text;
}

// T1 - anti-drift
test('template output classifies with zero unverified segments', () => {
  const result = classifyDraft({
    text: templateDraft(),
    evidenceItems: evidenceItems(),
    request: request()
  });
  assert.deepEqual(result.unverified, []);
  assert.equal(result.counts.UNVERIFIED, 0);
  assert.equal(result.counts.EVIDENCE, 1);
  assert.equal(result.counts.REQUEST, 1);
  assert.equal(result.counts.TEMPLATE, 2);
  assert.equal(result.segments.length, 4);
});

// T6 - evidence carries its id
test('an evidence segment is labelled EVIDENCE and carries its evidenceId', () => {
  const result = classifyDraft({
    text: templateDraft(),
    evidenceItems: evidenceItems(),
    request: request()
  });
  const evidence = result.segments.filter((s) => s.label === 'EVIDENCE');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].text, CLAIM);
  assert.equal(evidence[0].evidenceId, 'fact-agent-workflows');
});

// T5 - request-derived is not confused with template or evidence
test('the greeting and role/company segment is labelled REQUEST', () => {
  const result = classifyDraft({
    text: templateDraft(),
    evidenceItems: evidenceItems(),
    request: request()
  });
  const requestSegments = result.segments.filter((s) => s.label === 'REQUEST');
  assert.equal(requestSegments.length, 1);
  assert.match(requestSegments[0].text, /Example Company/);
  assert.equal(requestSegments[0].evidenceId, undefined);
});

// T4 - fabrication surfaces
test('a fabricated segment is labelled UNVERIFIED', () => {
  const fabricated = 'Van led a 12-person ML platform team at Google.';
  const result = classifyDraft({
    text: `${templateDraft()}\n\n${fabricated}`,
    evidenceItems: evidenceItems(),
    request: request()
  });
  assert.deepEqual(result.unverified, [fabricated]);
  assert.equal(result.counts.UNVERIFIED, 1);
});

test('classification is case and whitespace insensitive', () => {
  const result = classifyDraft({
    text: `  ${CLAIM.toUpperCase()}  `,
    evidenceItems: evidenceItems(),
    request: request()
  });
  assert.equal(result.counts.EVIDENCE, 1);
  assert.equal(result.counts.UNVERIFIED, 0);
});

test('classifyDraft throws FAILED_DRAFT_CLASSIFICATION on malformed input', () => {
  const cases = [
    { text: '', evidenceItems: evidenceItems(), request: request() },
    { text: templateDraft(), evidenceItems: [], request: request() },
    { text: templateDraft(), evidenceItems: evidenceItems(), request: {} },
    undefined
  ];
  for (const input of cases) {
    assert.throws(() => classifyDraft(input), (error) => {
      assert.equal(error.code, 'FAILED_DRAFT_CLASSIFICATION');
      return true;
    });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/path-workflows/recruiter/draft-classifier.test.mjs`
Expected: FAIL — cannot find module `draft-classifier.mjs`.

- [ ] **Step 3: Write the classifier**

Create `path-workflows/recruiter/draft-classifier.mjs`:

```js
import { renderRequestFrame, TEMPLATE_SEGMENTS } from '../../path-brain/recruiter-template.mjs';
import { splitClaims } from '../../path-safety/fact-resolver.mjs';

export function classifyDraft({ text, evidenceItems, request } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0 ||
      !Array.isArray(evidenceItems) || evidenceItems.length === 0 ||
      !evidenceItems.every((item) => isRecord(item) &&
        nonempty(item.id) && nonempty(item.quote)) ||
      !isRecord(request) || !isRecord(request.recipient) ||
      !isRecord(request.opportunity) || !nonempty(request.recipient.name) ||
      !nonempty(request.opportunity.company) || !nonempty(request.opportunity.role)) {
    throw codedError('FAILED_DRAFT_CLASSIFICATION');
  }

  const evidenceById = new Map(
    evidenceItems.map((item) => [normalize(item.quote), item.id])
  );
  const requestSegments = new Set(
    splitClaims(renderRequestFrame(request)).map(normalize)
  );
  const templateSegments = new Set(
    TEMPLATE_SEGMENTS.flatMap((segment) => splitClaims(segment)).map(normalize)
  );

  const segments = splitClaims(text).map((segment) => {
    const key = normalize(segment);
    if (evidenceById.has(key)) {
      return { text: segment, label: 'EVIDENCE', evidenceId: evidenceById.get(key) };
    }
    if (requestSegments.has(key)) return { text: segment, label: 'REQUEST' };
    if (templateSegments.has(key)) return { text: segment, label: 'TEMPLATE' };
    return { text: segment, label: 'UNVERIFIED' };
  });

  const counts = { EVIDENCE: 0, REQUEST: 0, TEMPLATE: 0, UNVERIFIED: 0 };
  for (const segment of segments) counts[segment.label] += 1;

  return {
    segments,
    counts,
    unverified: segments.filter((s) => s.label === 'UNVERIFIED').map((s) => s.text)
  };
}

function normalize(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/path-workflows/recruiter/draft-classifier.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add path-workflows/recruiter/draft-classifier.mjs tests/path-workflows/recruiter/draft-classifier.test.mjs
git commit -m "Add draft segment classifier"
```

---

### Task 3: Embed the classification in the claim report

Adding a field changes the report shape, so `schemaVersion` moves to `path.claim-report.v2`. `tests/path-workflows/recruiter/claim-report.test.mjs:57` asserts the whole object with `deepEqual` and must be updated in the same commit.

**Files:**
- Modify: `path-workflows/recruiter/claim-report.mjs:9-37`
- Modify: `path-workflows/recruiter/recruiter-workflow.mjs:87`
- Test: `tests/path-workflows/recruiter/claim-report.test.mjs:56-71`

**Interfaces:**
- Consumes: `classifyDraft` (Task 2).
- Produces: `buildClaimReport({ brainOutput, selection, request })` returns the existing object plus `draftClassification`, with `schemaVersion: 'path.claim-report.v2'`.

- [ ] **Step 1: Update the existing exact-shape test**

In `tests/path-workflows/recruiter/claim-report.test.mjs`, the test at line 56 currently passes `{ brainOutput, selection }` and asserts `schemaVersion: 'path.claim-report.v1'`. Replace its body with:

```js
test('buildClaimReport derives an exact supported report from validated selected evidence', () => {
  const report = buildClaimReport({
    brainOutput: brainOutput(),
    selection: selection(),
    request: {
      recipient: { name: 'Hiring Manager' },
      opportunity: { company: 'Example Company', role: 'AI Engineer' }
    }
  });

  assert.equal(report.schemaVersion, 'path.claim-report.v2');
  assert.equal(report.draftSha256,
    '6168c4e05682895f2684faee883d29a95aaed784ec827bbb366fc4dffd7354a4');
  assert.deepEqual(report.declaredClaims, [CLAIM]);
  assert.deepEqual(report.supported, [CLAIM]);
  assert.deepEqual(report.unsupported, []);
  assert.deepEqual(report.evidenceIds, ['fact-agent-workflows']);
  assert.equal(report.status, 'SUPPORTED');
  assert.deepEqual(report.draftClassification.unverified, []);
  assert.equal(report.draftClassification.counts.UNVERIFIED, 0);
});
```

Every other test in this file calls `buildClaimReport` without `request`; add the same `request` object to each call so they keep passing.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/path-workflows/recruiter/claim-report.test.mjs`
Expected: FAIL — `schemaVersion` is `path.claim-report.v1` and `draftClassification` is undefined.

- [ ] **Step 3: Wire the classifier in**

In `path-workflows/recruiter/claim-report.mjs`, add to the imports:

```js
import { classifyDraft } from './draft-classifier.mjs';
```

Change the signature and return value:

```js
export function buildClaimReport({ brainOutput, selection, request } = {}) {
```

Immediately before the `return {`:

```js
  const draftClassification = classifyDraft({
    text: brainOutput.text,
    evidenceItems: selection.items,
    request
  });
```

In the returned object, change `schemaVersion` to `'path.claim-report.v2'` and add after `evidenceIds`:

```js
    draftClassification,
```

- [ ] **Step 4: Pass `request` at the call site**

In `path-workflows/recruiter/recruiter-workflow.mjs:87`, change:

```js
    const claimReport = buildClaimReport({ brainOutput, selection });
```

to:

```js
    const claimReport = buildClaimReport({ brainOutput, selection, request });
```

`request` is already in scope from line 47.

- [ ] **Step 5: Run the workflow suites**

Run: `node --test tests/path-workflows/recruiter/*.test.mjs`
Expected: PASS. `claim-report.json` now carries `draftClassification`, which flows into `claimReportHash` and the packet with no further change (T7).

- [ ] **Step 6: Commit**

```bash
git add path-workflows/recruiter/claim-report.mjs path-workflows/recruiter/recruiter-workflow.mjs tests/path-workflows/recruiter/claim-report.test.mjs
git commit -m "Embed draft classification in the claim report"
```

---

### Task 4: Surface unverified segments in the run summary

`run-summary.md` is what the reviewer reads before approving. `tests/path-workflows/recruiter/recruiter-workflow.test.mjs` asserts its content exactly and must be updated in the same commit.

**Files:**
- Modify: `path-workflows/recruiter/summary-writer.mjs:4-19`
- Modify: `path-workflows/recruiter/recruiter-workflow.mjs:157-162`
- Test: `tests/path-workflows/recruiter/recruiter-workflow.test.mjs`

**Interfaces:**
- Consumes: `draftClassification` from the claim report (Task 3).
- Produces: `renderRunSummary({ runId, packetId, classification })`. `classification` is the `draftClassification` object. Omitting it throws `BLOCKED_INVALID_SUMMARY`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/path-workflows/recruiter/recruiter-workflow.test.mjs`:

```js
test('run summary accounts for every draft segment on a clean run', async (t) => {
  const rootDir = makeSandbox(t);
  await runRecruiterWorkflow(workflowOptions(rootDir));
  const summary = fs.readFileSync(runPath(rootDir, 'run-summary.md'), 'utf8');

  assert.match(summary, /- Draft segments: 4 - all accounted for/);
  assert.match(summary, /\(1 evidence, 1 from request, 2 template wording\)/);
  assert.doesNotMatch(summary, /UNVERIFIED/);
  assert.doesNotMatch(summary.toLowerCase(), /\bverified\b(?! segments)/);
});
```

Then update the existing exact-summary assertion (the test asserting the full
`# Path Recruiter Run ...` block) to include the new line after `- Safety tier: YELLOW`:

```
- Draft segments: 4 - all accounted for
  (1 evidence, 1 from request, 2 template wording)
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/path-workflows/recruiter/recruiter-workflow.test.mjs`
Expected: FAIL — summary has no `Draft segments` line.

- [ ] **Step 3: Extend the summary writer**

Replace `path-workflows/recruiter/summary-writer.mjs` with:

```js
const RUN_ID = /^run-[a-z0-9-]+$/;
const PACKET_ID = /^[a-f0-9]{16}$/;

export function renderRunSummary({ runId, packetId, classification } = {}) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) ||
      typeof packetId !== 'string' || !PACKET_ID.test(packetId) ||
      !isRecord(classification) || !isRecord(classification.counts) ||
      !Array.isArray(classification.unverified)) {
    throw codedError('BLOCKED_INVALID_SUMMARY');
  }

  const { EVIDENCE, REQUEST, TEMPLATE, UNVERIFIED } = classification.counts;
  const total = EVIDENCE + REQUEST + TEMPLATE + UNVERIFIED;
  const accounting = UNVERIFIED === 0
    ? `- Draft segments: ${total} - all accounted for
  (${EVIDENCE} evidence, ${REQUEST} from request, ${TEMPLATE} template wording)`
    : `- Draft segments: ${total} - ${UNVERIFIED} UNVERIFIED`;

  const unverifiedSection = UNVERIFIED === 0 ? '' : `
## Unverified segments

${classification.unverified.map((text, index) => `${index + 1}. ${JSON.stringify(text)}`).join('\n')}
`;

  return `# Path Recruiter Run ${runId}

- Status: HUMAN_REVIEW
- Result: LOCAL_REVIEW_READY
- Draft: draft.md
- Claim report: claim-report.json
- Approval packet: ${packetId}
- Safety tier: YELLOW
${accounting}
- External action: NONE — HUMAN REVIEW REQUIRED
${unverifiedSection}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
```

- [ ] **Step 4: Pass the classification at the call site**

In `path-workflows/recruiter/recruiter-workflow.mjs:161`, change:

```js
      content: renderRunSummary({ runId, packetId })
```

to:

```js
      content: renderRunSummary({
        runId,
        packetId,
        classification: claimReport.draftClassification
      })
```

`claimReport` is in scope from line 87.

- [ ] **Step 5: Run the workflow and CLI suites**

Run: `node --test tests/path-workflows/recruiter/*.test.mjs tests/path-cli/*.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add path-workflows/recruiter/summary-writer.mjs path-workflows/recruiter/recruiter-workflow.mjs tests/path-workflows/recruiter/recruiter-workflow.test.mjs
git commit -m "Report draft segment accounting in the run summary"
```

---

### Task 5: Prove report-only behaviour and the failure path

The two properties most likely to be broken by a future edit: unverified content must never block, and a classifier failure must never produce a packet.

**Files:**
- Test: `tests/path-workflows/recruiter/recruiter-workflow.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Add to `tests/path-workflows/recruiter/recruiter-workflow.test.mjs`:

```js
// T2 - unverified content must not block
test('a draft with unverified segments still reaches HUMAN_REVIEW', async (t) => {
  const rootDir = makeSandbox(t);
  const chattyProvider = {
    async generate(input) {
      const base = await fakeProvider.generate(input);
      return {
        ...base,
        text: `${base.text}\n\nVan led a 12-person ML platform team at Google.`
      };
    }
  };

  const result = await runRecruiterWorkflow(
    workflowOptions(rootDir, { provider: chattyProvider })
  );

  assert.equal(result.status, 'HUMAN_REVIEW');
  assert.equal(result.resultCode, 'LOCAL_REVIEW_READY');

  const report = readJson(runPath(rootDir, 'claim-report.json'));
  assert.deepEqual(report.draftClassification.unverified, [
    'Van led a 12-person ML platform team at Google.'
  ]);

  const summary = fs.readFileSync(runPath(rootDir, 'run-summary.md'), 'utf8');
  assert.match(summary, /1 UNVERIFIED/);
  assert.match(summary, /## Unverified segments/);
  assert.match(summary, /12-person ML platform team/);
});

// T3 - the existing hard block survived
test('a declared claim absent from evidence still blocks', async (t) => {
  const rootDir = makeSandbox(t);
  const lyingProvider = {
    async generate(input) {
      const base = await fakeProvider.generate(input);
      const invented = 'Van invented an unsupported claim.';
      return {
        ...base,
        text: `${base.text}\n\n${invented}`,
        claims: [invented]
      };
    }
  };

  const result = await runRecruiterWorkflow(
    workflowOptions(rootDir, { provider: lyingProvider })
  );

  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.resultCode, 'BLOCKED_UNSUPPORTED_CLAIMS');
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), false);
});

// T8 - classifier failure must not produce a packet
test('a classifier failure ends the run FAILED without queueing a packet', async (t) => {
  const rootDir = makeSandbox(t);
  const emptyEvidenceProvider = {
    async generate(input) {
      const base = await fakeProvider.generate(input);
      return { ...base, text: '   ' };
    }
  };

  const result = await runRecruiterWorkflow(
    workflowOptions(rootDir, { provider: emptyEvidenceProvider })
  );

  assert.equal(result.status, 'FAILED');
  assert.equal(result.packetId, null);
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), false);
});
```

- [ ] **Step 2: Run to verify T2 and T8 fail and T3 passes**

Run: `node --test tests/path-workflows/recruiter/recruiter-workflow.test.mjs`
Expected: T3 PASSES already (the hard block is untouched — this test pins it). T2 and T8 depend on Tasks 2-4 being complete; if any fail, fix the implementation, not the test.

Note: the empty-text provider in T8 is rejected by `validateBrainOutput` before reaching `classifyDraft`, producing `FAILED_BRAIN_OUTPUT_INVALID`. That still satisfies the assertion — the point is that no packet is queued. If a distinct `FAILED_DRAFT_CLASSIFICATION` path is wanted, assert on `result.resultCode` matching `/^FAILED_/` rather than an exact code.

- [ ] **Step 3: Run every path suite**

Run: `npm run test:path-safety` then `npm run test:path-agent`
Expected: both exit 0. On Windows, six symlink tests skip with `EPERM`.

- [ ] **Step 4: Verify on Linux**

Export the committed tree to a scratch directory outside the repo, then run
the suite against it in a Linux container. Substitute your own scratch path
for `$REPRO`, and its host-native form for `<REPRO-HOST-PATH>`.

```bash
rm -rf "$REPRO" && mkdir -p "$REPRO"
git archive HEAD | tar -x -C "$REPRO"
```

```bash
docker run --rm -v "<REPRO-HOST-PATH>:/app" -w /app node:24 sh -c "npm install --ignore-scripts >/dev/null 2>&1; npm run test:path-agent"
```

Expected: 0 failures, 0 skipped. All six symlink tests execute.

- [ ] **Step 5: Commit**

```bash
git add tests/path-workflows/recruiter/recruiter-workflow.test.mjs
git commit -m "Pin report-only classification and the no-packet failure path"
```

---

## Self-review notes

- **Spec coverage.** Decisions 1-4 map to Tasks 2-5. Labels and the single-source-of-truth rule map to Tasks 1-2. Data flow maps to Task 3. Reviewer output maps to Task 4. Error handling maps to Tasks 2 and 5. Known limitation is encoded in Task 2's segment counts (4, not 6). Out-of-scope items have no tasks, by design.
- **Two spec gaps found while planning.** The spec did not mention that `claim-report.test.mjs:57` asserts the report shape with `deepEqual`, nor that `recruiter-workflow.test.mjs` asserts summary text exactly. Both break on shape change; Tasks 3 and 4 update them in the same commit as the change.
- **Schema version.** The spec did not specify. This plan bumps to `path.claim-report.v2` because the shape changed. Nothing in `path-safety/` reads that field, so the bump is safe.
- **Type consistency.** `classifyDraft` returns `segments`, `counts`, `unverified` in Task 2 and is consumed under those names in Tasks 3-5. `renderRunSummary` takes `classification` in Task 4 and is called with that name in the same task.
