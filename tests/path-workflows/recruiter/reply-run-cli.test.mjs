import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = path.resolve('scripts/path-reply-run.mjs');
const CLAIM = 'Van builds agent workflows on Windows 11 with PowerShell.';
const SOURCE_TEXT = `# Synthetic CV

${CLAIM}
`;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeSandbox(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-reply-run-'));
  fs.writeFileSync(path.join(rootDir, 'cv.md'), SOURCE_TEXT, 'utf8');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function writeJson(rootDir, name, value) {
  const filePath = path.join(rootDir, name);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

test('path-reply-run queues a fake-provider reply packet without sending mail', (t) => {
  const rootDir = makeSandbox(t);
  const candidatePath = writeJson(rootDir, 'candidate.json', {
    message_id: 'gmail-message-123',
    from: 'Recruiter <recruiter@example.test>',
    subject: 'Re: AI Engineer at Example Company',
    body_snippet: 'Could you share a few times that work for Van?',
    signal: null,
    thread_id: 'thread-123',
    message_id_header: '<gmail-message-123@example.test>',
    references: '<root@example.test>'
  });
  const contextPath = writeJson(rootDir, 'reply-context.json', {
    opportunity: { company: 'Example Company', role: 'AI Engineer' },
    requestApproval: {
      principal: 'Van',
      approvedAt: '2026-07-29T11:30:00Z',
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
      approvedAt: '2026-07-29T11:00:00Z',
      factRecordedAt: '2026-07-29T10:00:00Z',
      freshness: { mode: 'STATIC' },
      supersedesFactIds: []
    }]
  });

  const result = spawnSync(process.execPath, [SCRIPT, candidatePath, contextPath, rootDir], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 'HUMAN_REVIEW');
  assert.equal(out.resultCode, 'LOCAL_REVIEW_READY');
  assert.equal(out.sent, false);
  const outbox = fs.readFileSync(path.join(rootDir, 'data', 'path-outbox.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].action.touch, 'reply');
  assert.equal(outbox[0].action.threadId, 'thread-123');
  assert.equal(fs.existsSync(path.join(rootDir, 'data', 'path-dispatch.jsonl')), false);
});
