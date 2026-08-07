import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { fakeProvider } from '../../../path-brain/fake-provider.mjs';
import { noModelProvider } from '../../../path-brain/no-model-provider.mjs';
import { createRun } from '../../../path-runner/lifecycle.mjs';
import { appendAuditRecord } from '../../../path-safety/audit-ledger.mjs';
import { gateOutbound } from '../../../path-safety/outbound-gate.mjs';
import { runRecruiterWorkflow } from '../../../path-workflows/recruiter/recruiter-workflow.mjs';

// Must track the real clock: packets expire 24h after createdAt, and the
// path-approve.mjs subprocess below reads the system time, not this value.
// A pinned date makes every packet minted here expire 24h later, forever.
const NOW = new Date();
const APPROVAL_SCRIPT = path.resolve('scripts/path-approve.mjs');
const CLAIM = 'Van builds agent workflows on Windows 11 with PowerShell.';
const SOURCE_TEXT = `# Synthetic CV

${CLAIM}
`;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeSandbox(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-recruiter-workflow-'));
  fs.writeFileSync(path.join(rootDir, 'cv.md'), SOURCE_TEXT, 'utf8');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function rawRequest(overrides = {}) {
  return {
    schemaVersion: 'path.recruiter.request.v1',
    runId: 'run-test-001',
    createdAt: '2026-07-29T12:00:00.000Z',
    objective: 'draft_first_touch',
    action: { type: 'send_email', channel: 'email', touch: 'first' },
    recipient: { name: 'Hiring Manager', address: 'hiring@example.test' },
    opportunity: { company: 'Example Company', role: 'AI Engineer' },
    promptVersion: 'path-recruiter-v1',
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    provider: 'fake',
    requestApproval: {
      principal: 'Van',
      approvedAt: '2026-07-29T11:30:00.000Z',
      scope: 'THIS_REQUEST_ONLY'
    },
    evidenceRefs: [{
      id: 'fact-agent-workflows',
      factKey: 'capability.agent-workflows',
      source: 'cv.md',
      sourceType: 'USER_LAYER_FACT',
      expectedSourceSha256: sha256(SOURCE_TEXT),
      quote: CLAIM,
      authority: 'OWNER_APPROVED_FACT',
      approvedBy: 'Van',
      approvedAt: '2026-07-29T11:00:00.000Z',
      factRecordedAt: '2026-07-29T10:00:00.000Z',
      freshness: { mode: 'STATIC' },
      supersedesFactIds: []
    }],
    ...overrides
  };
}

function workflowOptions(rootDir, overrides = {}) {
  return {
    rootDir,
    rawRequest: rawRequest(),
    provider: fakeProvider,
    now: () => new Date(NOW),
    idFactory: () => 'test-temp-001',
    ...overrides
  };
}

function runPath(rootDir, name) {
  return path.join(rootDir, 'data', 'path-runs', 'run-test-001', name);
}

function dataPath(rootDir, name) {
  return path.join(rootDir, 'data', name);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function expectedFailure(status, resultCode, overrides = {}) {
  return {
    status,
    resultCode,
    decision: null,
    packetId: null,
    runId: 'run-test-001',
    ...overrides
  };
}

function outputFor({ claims = [CLAIM], text }) {
  return {
    schemaVersion: 'path.brain.output.v1',
    provider: 'fake',
    model: 'deterministic-recruiter-template-v1',
    promptVersion: 'path-recruiter-v1',
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    disclosureIncluded: true,
    claims,
    text: text ?? `${claims.join(' ')} Prepared with Path, Van's AI recruiting assistant.`
  };
}

test('successful workflow writes exact local artifacts and returns only the review-ready result', async (t) => {
  const rootDir = makeSandbox(t);
  let brainCalls = 0;
  const provider = {
    async generate(input) {
      brainCalls += 1;
      return fakeProvider.generate(input);
    }
  };

  const result = await runRecruiterWorkflow(workflowOptions(rootDir, { provider }));

  assert.equal(brainCalls, 1);
  assert.deepEqual(result, {
    status: 'HUMAN_REVIEW',
    resultCode: 'LOCAL_REVIEW_READY',
    decision: 'QUEUE_FOR_APPROVAL',
    packetId: result.packetId,
    runId: 'run-test-001'
  });
  assert.match(result.packetId, /^[a-f0-9]{16}$/);
  for (const artifact of [
    'request.json',
    'evidence-selection.json',
    'draft.md',
    'claim-report.json',
    'run-summary.md',
    'events.jsonl',
    'run-state.json'
  ]) {
    assert.equal(fs.existsSync(runPath(rootDir, artifact)), true, artifact);
  }
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), true);
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-audit.jsonl')), true);
  const outbox = fs.readFileSync(dataPath(rootDir, 'path-outbox.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].tier, 'YELLOW');
  assert.equal(readJson(runPath(rootDir, 'run-state.json')).status, 'HUMAN_REVIEW');
  const summary = fs.readFileSync(runPath(rootDir, 'run-summary.md'), 'utf8');
  assert.equal(summary, `# Path Recruiter Run run-test-001

- Status: HUMAN_REVIEW
- Result: LOCAL_REVIEW_READY
- Draft: draft.md
- Claim report: claim-report.json
- Approval packet: ${result.packetId}
- Safety tier: YELLOW
- Draft segments: 4 - all accounted for
  (1 evidence, 1 from request, 2 template wording)
- External action: NONE — HUMAN REVIEW REQUIRED
`);
  assert.doesNotMatch(summary.toLowerCase(), /\b(success|sent|dispatched|approved)\b/);
});

test('run summary accounts for every draft segment on a clean run', async (t) => {
  const rootDir = makeSandbox(t);
  await runRecruiterWorkflow(workflowOptions(rootDir));
  const summary = fs.readFileSync(runPath(rootDir, 'run-summary.md'), 'utf8');

  assert.match(summary, /- Draft segments: 4 - all accounted for/);
  assert.match(summary, /\(1 evidence, 1 from request, 2 template wording\)/);
  assert.doesNotMatch(summary, /UNVERIFIED/);
  assert.doesNotMatch(summary, /\bverified\b/i);
});

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

// Invalid brain output (blank text) is rejected by validateBrainOutput before
// classifyDraft ever runs. This test does not exercise the classifier's own
// throw path — that is covered by a unit test in
// tests/path-workflows/recruiter/draft-classifier.test.mjs. What this test
// pins is the workflow-level property: a FAILED run must never queue a
// packet or write an outbox entry.
test('invalid brain output ends the run FAILED and queues no packet', async (t) => {
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

test('packet from a run that fails after queueing is not approvable', async (t) => {
  const rootDir = makeSandbox(t);
  const fsImpl = {
    ...fs,
    renameSync(source, target) {
      if (target.endsWith(`${path.sep}run-summary.md`)) {
        throw Object.assign(new Error('synthetic summary failure'), {
          code: 'FAILED_SUMMARY_WRITE'
        });
      }
      return fs.renameSync(source, target);
    }
  };

  const result = await runRecruiterWorkflow(workflowOptions(rootDir, { fsImpl }));

  assert.deepEqual(result, expectedFailure('FAILED', 'FAILED_ARTIFACT_WRITE', {
    decision: 'QUEUE_FOR_APPROVAL',
    packetId: result.packetId
  }));
  assert.equal(readJson(runPath(rootDir, 'run-state.json')).status, 'FAILED');
  const approval = spawnSync(
    process.execPath,
    [APPROVAL_SCRIPT, result.packetId, 'APPROVED'],
    { cwd: rootDir, encoding: 'utf8' }
  );
  assert.equal(approval.status, 1);
  assert.equal(JSON.parse(approval.stdout).status, 'BLOCKED_RUN_NOT_REVIEW_READY');
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-approvals.jsonl')), false);
});

test('absent quote blocks before Brain and outbox', async (t) => {
  const rootDir = makeSandbox(t);
  const request = rawRequest();
  request.evidenceRefs[0].quote = 'This exact sentence is absent.';
  let brainCalls = 0;
  const result = await runRecruiterWorkflow(workflowOptions(rootDir, {
    rawRequest: request,
    provider: { generate() { brainCalls += 1; } }
  }));

  assert.deepEqual(result, expectedFailure('BLOCKED', 'BLOCKED_EVIDENCE_NOT_FOUND'));
  assert.equal(brainCalls, 0);
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), false);
  assert.equal(readJson(runPath(rootDir, 'run-state.json')).status, 'BLOCKED');
});

test('no-model provider blocks without outbox', async (t) => {
  const rootDir = makeSandbox(t);
  const request = rawRequest({ provider: 'none' });
  const result = await runRecruiterWorkflow(workflowOptions(rootDir, {
    rawRequest: request,
    provider: noModelProvider
  }));

  assert.deepEqual(result, expectedFailure('BLOCKED', 'BLOCKED_NO_MODEL_CONFIGURED'));
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), false);
  assert.equal(readJson(runPath(rootDir, 'run-state.json')).status, 'BLOCKED');
});

test('provider timeout fails after one call with no fallback or outbox', async (t) => {
  const rootDir = makeSandbox(t);
  let brainCalls = 0;
  let fallbackCalls = 0;
  const provider = {
    async generate() {
      brainCalls += 1;
      throw Object.assign(new Error('synthetic timeout'), { code: 'FAILED_BRAIN_TIMEOUT' });
    },
    fallback() {
      fallbackCalls += 1;
    }
  };
  const result = await runRecruiterWorkflow(workflowOptions(rootDir, { provider }));

  assert.deepEqual(result, expectedFailure('FAILED', 'FAILED_BRAIN_TIMEOUT'));
  assert.equal(brainCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), false);
  assert.equal(readJson(runPath(rootDir, 'run-state.json')).status, 'FAILED');
});

test('unsupported provider claim writes claim report and blocks before gate, audit, and outbox', async (t) => {
  const rootDir = makeSandbox(t);
  const unsupported = 'Van invented an unsupported claim.';
  let brainCalls = 0;
  let gateCalls = 0;
  const provider = {
    async generate() {
      brainCalls += 1;
      return outputFor({ claims: [unsupported] });
    }
  };
  const result = await runRecruiterWorkflow(workflowOptions(rootDir, {
    provider,
    gateOutboundFn() {
      gateCalls += 1;
    }
  }));

  assert.deepEqual(result, expectedFailure('BLOCKED', 'BLOCKED_UNSUPPORTED_CLAIMS'));
  assert.equal(brainCalls, 1);
  assert.equal(gateCalls, 0);
  assert.equal(readJson(runPath(rootDir, 'claim-report.json')).status,
    'BLOCKED_UNSUPPORTED_CLAIMS');
  assert.equal(readJson(runPath(rootDir, 'run-state.json')).status, 'BLOCKED');
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-audit.jsonl')), false);
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), false);
});

test('RED commitment blocks without outbox', async (t) => {
  const rootDir = makeSandbox(t);
  const provider = {
    async generate() {
      return outputFor({ text: `I accept the offer. ${CLAIM}` });
    }
  };
  const result = await runRecruiterWorkflow(workflowOptions(rootDir, { provider }));

  assert.deepEqual(result, expectedFailure('BLOCKED', 'BLOCK_RED', {
    decision: 'BLOCK_RED',
    packetId: result.packetId
  }));
  assert.match(result.packetId, /^[a-f0-9]{16}$/);
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), false);
  assert.equal(readJson(runPath(rootDir, 'run-state.json')).status, 'BLOCKED');
});

test('audit append failure returns FAILED_AUDIT_WRITE without review-ready result or outbox', async (t) => {
  const rootDir = makeSandbox(t);
  const result = await runRecruiterWorkflow(workflowOptions(rootDir, {
    gateOptions: {
      appendAudit() {
        throw Object.assign(new Error('synthetic audit failure'), {
          code: 'FAILED_AUDIT_WRITE'
        });
      }
    }
  }));

  assert.deepEqual(result, expectedFailure('FAILED', 'FAILED_AUDIT_WRITE'));
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), false);
  assert.equal(readJson(runPath(rootDir, 'run-state.json')).status, 'FAILED');
});

test('outbox without matching queued audit is recorded and returned unresolved', async (t) => {
  const rootDir = makeSandbox(t);
  let auditCalls = 0;
  const result = await runRecruiterWorkflow(workflowOptions(rootDir, {
    gateOptions: {
      appendAudit(auditPath, record, options) {
        auditCalls += 1;
        if (auditCalls === 2) return undefined;
        return appendAuditRecord(auditPath, record, options);
      }
    }
  }));

  assert.deepEqual(result, expectedFailure('UNRESOLVED', 'UNRESOLVED_QUEUE_AUDIT', {
    decision: 'QUEUE_FOR_APPROVAL',
    packetId: result.packetId
  }));
  assert.match(result.packetId, /^[a-f0-9]{16}$/);
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), true);
  assert.equal(fs.existsSync(runPath(rootDir, 'run-summary.md')), false);
  assert.equal(readJson(runPath(rootDir, 'run-state.json')).status, 'UNRESOLVED');
});

test('duplicate run ID blocks without creating outbox', async (t) => {
  const rootDir = makeSandbox(t);
  createRun({ rootDir, runId: 'run-test-001' }, {
    now: () => new Date(NOW),
    idFactory: () => 'preexisting-temp-001'
  });

  const result = await runRecruiterWorkflow(workflowOptions(rootDir));

  assert.deepEqual(result, expectedFailure('BLOCKED', 'BLOCKED_DUPLICATE_RUN'));
  assert.equal(readJson(runPath(rootDir, 'run-state.json')).status, 'CREATED');
  assert.equal(fs.existsSync(dataPath(rootDir, 'path-outbox.jsonl')), false);
});

test('transport, send, browser, and connector dependencies are rejected at every injection point', async (t) => {
  for (const dependencyName of ['transport', 'send', 'browser', 'connector']) {
    for (const nested of [false, true]) {
      const rootDir = makeSandbox(t);
      let calls = 0;
      const dependency = () => { calls += 1; };
      const injected = nested
        ? { gateOptions: { [dependencyName]: dependency } }
        : { [dependencyName]: dependency };
      const result = await runRecruiterWorkflow(workflowOptions(rootDir, injected));

      assert.deepEqual(result,
        expectedFailure('BLOCKED', 'BLOCKED_INVALID_DEPENDENCY'));
      assert.equal(calls, 0, `${nested ? 'gateOptions.' : ''}${dependencyName}`);
      assert.equal(fs.existsSync(path.join(rootDir, 'data')), false,
        `${nested ? 'gateOptions.' : ''}${dependencyName}`);
    }
  }
});
