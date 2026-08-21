import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { fakeProvider } from '../../path-brain/fake-provider.mjs';
import { buildReplyRequestFromCandidate } from '../../path-workflows/recruiter/reply-request-builder.mjs';
import { runRecruiterWorkflow } from '../../path-workflows/recruiter/recruiter-workflow.mjs';
import { appendAuditRecord } from '../../path-safety/audit-ledger.mjs';

// Must track the real clock: the dispatch subprocess reads system time and
// packets expire 24h after createdAt.
const CLAIM = 'Van builds agent workflows on Windows 11 with PowerShell.';
const SOURCE_TEXT = `# Synthetic CV

${CLAIM}
`;
const DISPATCH_SCRIPT = path.resolve('scripts/path-dispatch.mjs');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function makeSandbox(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-reply-e2e-'));
  fs.writeFileSync(path.join(rootDir, 'cv.md'), SOURCE_TEXT, 'utf8');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function scannerCandidate() {
  return {
    message_id: 'gmail-message-123',
    from: 'Recruiter <recruiter@example.test>',
    subject: 'Re: AI Engineer at Example Company',
    body_snippet: 'Could you share a few times that work for Van?',
    signal: null,
    thread_id: 'thread-123',
    message_id_header: '<gmail-message-123@example.test>',
    references: '<root@example.test>'
  };
}

function builderContext() {
  return {
    opportunity: { company: 'Example Company', role: 'AI Engineer' },
    provider: 'fake',
    requestApproval: {
      principal: 'Van',
      approvedAt: hoursAgo(1),
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
      approvedAt: hoursAgo(2),
      factRecordedAt: hoursAgo(3),
      freshness: { mode: 'STATIC' },
      supersedesFactIds: []
    }]
  };
}

function queueReplyPacket(t, rootDir) {
  const rawRequest = buildReplyRequestFromCandidate(scannerCandidate(), builderContext(), {
    now: () => new Date(),
    idFactory: () => `run-${crypto.randomBytes(8).toString('hex')}`
  });
  return runRecruiterWorkflow({
    rootDir,
    rawRequest,
    provider: fakeProvider,
    now: () => new Date()
  });
}

function readOutbox(rootDir) {
  const outboxPath = path.join(rootDir, 'data', 'path-outbox.jsonl');
  return fs.readFileSync(outboxPath, 'utf8').trim().split('\n').map(JSON.parse);
}

function auditRecordFor(packet) {
  return {
    event: 'approval_decision_recorded',
    runId: null,
    packetId: packet.id,
    integritySha256: packet.integritySha256,
    idempotencyKey: packet.idempotencyKey,
    action: packet.action,
    recipient: packet.recipient,
    finalText: packet.finalText,
    evidenceIds: packet.evidenceIds,
    evidenceHashes: packet.evidenceHashes,
    claimReportHash: packet.claimReportHash,
    tier: packet.tier,
    policyVersion: packet.policyVersion,
    voiceProfile: packet.voiceProfile,
    disclosurePolicy: packet.disclosurePolicy,
    disclosureIncluded: packet.disclosureIncluded,
    provider: packet.provider,
    model: packet.model,
    promptVersion: packet.promptVersion,
    decision: 'APPROVED'
  };
}

function stageDispatchFiles(rootDir, packet, { decision = 'APPROVED' } = {}) {
  const dir = path.join(rootDir, 'dispatch');
  fs.mkdirSync(dir, { recursive: true });
  const packetPath = path.join(dir, 'packet.json');
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  const approvalsPath = path.join(dir, 'approvals.jsonl');
  fs.writeFileSync(approvalsPath, `${JSON.stringify({
    packetId: packet.id,
    integritySha256: packet.integritySha256,
    idempotencyKey: packet.idempotencyKey,
    decision,
    decidedBy: 'Van'
  })}\n`, 'utf8');
  const dispatchPath = path.join(dir, 'dispatch.jsonl');
  fs.writeFileSync(dispatchPath, '', 'utf8');
  const auditPath = path.join(dir, 'audit.jsonl');
  if (decision === 'APPROVED') appendAuditRecord(auditPath, auditRecordFor(packet));
  else fs.writeFileSync(auditPath, '', 'utf8');
  return { packetPath, approvalsPath, dispatchPath, auditPath };
}

function runDispatchCli(paths) {
  return spawnSync(process.execPath, [
    DISPATCH_SCRIPT,
    paths.packetPath,
    paths.approvalsPath,
    paths.dispatchPath,
    paths.auditPath,
    '--send'
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH_SEND_TRANSPORT: 'fake',
      PATH_SEND_FAKE_ECHO_THREAD: '1'
    }
  });
}

test('reply e2e: scanned candidate becomes an approved threaded reply dispatched through the gate', async (t) => {
  const rootDir = makeSandbox(t);

  const result = await queueReplyPacket(t, rootDir);
  assert.equal(result.status, 'HUMAN_REVIEW');

  const [packet] = readOutbox(rootDir);
  assert.equal(packet.promptVersion, 'path-reply-v1');
  assert.equal(packet.model, 'deterministic-reply-template-v1');
  assert.equal(packet.action.touch, 'reply');
  assert.equal(packet.action.threadId, 'thread-123');
  assert.equal(packet.action.inReplyTo, '<gmail-message-123@example.test>');
  assert.ok(packet.finalText.includes(CLAIM));
  assert.ok(packet.finalText.includes("Prepared with Path, Van's AI recruiting assistant."));

  const paths = stageDispatchFiles(rootDir, packet);
  const cli = runDispatchCli(paths);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);

  const out = JSON.parse(cli.stdout);
  assert.equal(out.mode, 'send');
  assert.equal(out.status, 'DISPATCHED');
  assert.equal(out.packetId, packet.id);
  assert.equal(out.messageId, 'fake-thread-123-reply-refs');

  const records = fs.readFileSync(paths.dispatchPath, 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].event, 'dispatch_completed');
  assert.equal(records[0].packetId, packet.id);
  assert.equal(records[0].messageId, 'fake-thread-123-reply-refs');
});

test('reply e2e: without Van approval the queued reply never reaches the transport', async (t) => {
  const rootDir = makeSandbox(t);

  const result = await queueReplyPacket(t, rootDir);
  assert.equal(result.status, 'HUMAN_REVIEW');
  const [packet] = readOutbox(rootDir);

  const paths = stageDispatchFiles(rootDir, packet, { decision: 'REJECTED' });
  const cli = runDispatchCli(paths);
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).status, 'BLOCKED_REJECTED');
  assert.equal(fs.readFileSync(paths.dispatchPath, 'utf8'), '');
});
