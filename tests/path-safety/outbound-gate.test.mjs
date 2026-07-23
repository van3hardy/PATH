import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gateOutbound } from '../../path-safety/outbound-gate.mjs';
import { loadFacts } from '../../path-safety/fact-resolver.mjs';

test('GREEN action is allowed without outbox queue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-green-'));
  const result = gateOutbound({
    action: { type: 'discover_roles', channel: 'internal' },
    recipient: null,
    text: '',
    facts: loadFacts('config/path.facts.yml'),
    promptVersion: 'path-recruiter-v1',
    model: 'test-model'
  }, {
    outboxPath: path.join(dir, 'outbox.jsonl'),
    auditPath: path.join(dir, 'audit.jsonl')
  });

  assert.equal(result.decision, 'ALLOW_GREEN');
  assert.equal(fs.existsSync(path.join(dir, 'outbox.jsonl')), false);
});

test('YELLOW action is queued and not sent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-yellow-'));
  const result = gateOutbound({
    action: { type: 'send_email', channel: 'gmail', touch: 'first' },
    recipient: { name: 'Hiring Manager', address: 'hm@example.com' },
    text: 'Van builds agent workflows on Windows 11 with PowerShell.',
    facts: loadFacts('config/path.facts.yml'),
    promptVersion: 'path-recruiter-v1',
    model: 'test-model'
  }, {
    outboxPath: path.join(dir, 'outbox.jsonl'),
    auditPath: path.join(dir, 'audit.jsonl')
  });

  assert.equal(result.decision, 'QUEUE_FOR_APPROVAL');
  const queued = JSON.parse(fs.readFileSync(path.join(dir, 'outbox.jsonl'), 'utf8').trim());
  assert.equal(queued.status, 'AWAITING_VAN_APPROVAL');
  assert.equal(queued.recipient.address, 'hm@example.com');
});

test('RED action is blocked and audited', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-red-'));
  const result = gateOutbound({
    action: { type: 'send_email', channel: 'gmail', touch: 'first' },
    recipient: { name: 'Hiring Manager', address: 'hm@example.com' },
    text: 'I accept the offer and I can start Monday.',
    facts: loadFacts('config/path.facts.yml'),
    promptVersion: 'path-recruiter-v1',
    model: 'test-model'
  }, {
    outboxPath: path.join(dir, 'outbox.jsonl'),
    auditPath: path.join(dir, 'audit.jsonl')
  });

  assert.equal(result.decision, 'BLOCK_RED');
  assert.equal(fs.existsSync(path.join(dir, 'outbox.jsonl')), false);
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
  assert.match(audit, /outbound_blocked/);
});
