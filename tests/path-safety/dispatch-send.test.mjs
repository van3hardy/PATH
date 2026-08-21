import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { appendAuditRecord } from '../../path-safety/audit-ledger.mjs';
import { buildPacketIntegrityFields } from '../../path-safety/packet-integrity.mjs';

const scriptPath = path.resolve('scripts/path-dispatch.mjs');

function auditRecordFor(packet, decision = 'APPROVED') {
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
    decision
  };
}

function writeAuditLedger(dir, records) {
  const auditPath = path.join(dir, 'audit.jsonl');
  for (const record of records) appendAuditRecord(auditPath, record);
  return auditPath;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'path-send-'));
}

function makePacket(overrides = {}) {
  const createdAt = new Date().toISOString();
  const base = {
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString(),
    status: 'AWAITING_VAN_APPROVAL',
    tier: 'YELLOW',
    action: {
      type: 'send_email', channel: 'gmail', touch: 'first',
      opportunity: { company: 'Example Company', role: 'AI Engineer' }
    },
    recipient: { name: 'Hiring Manager', address: 'hm@example.com' },
    finalText: 'Agent workflows on Windows 11.',
    evidenceIds: ['fact-1'],
    evidenceHashes: ['a'.repeat(64)],
    claimReportHash: 'b'.repeat(64),
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    disclosureIncluded: true,
    promptVersion: 'path-recruiter-v1',
    provider: 'fake',
    model: 'deterministic-recruiter-template-v1',
    policyVersion: 'path-safety-v1',
    ...overrides
  };
  return { ...base, ...buildPacketIntegrityFields(base) };
}

function approvalFor(packet, decision = 'APPROVED') {
  return {
    packetId: packet.id,
    integritySha256: packet.integritySha256,
    idempotencyKey: packet.idempotencyKey,
    decision,
    decidedBy: 'Van'
  };
}

function makeLinkedinPacket(overrides = {}) {
  // Same address, second channel. The integrity check only requires any
  // non-empty action.channel, so a distinct action object is a valid packet.
  return makePacket({ action: {
    type: 'send_linkedin', channel: 'linkedin', touch: 'first',
    opportunity: { company: 'Example Company', role: 'AI Engineer' }
  }, ...overrides });
}

function runSendCli(packet, {
  decision = 'APPROVED',
  dispatches = [],
  env = {},
  extraFlags = [],
  contactsPath = null
} = {}) {
  const dir = tempDir();
  const packetPath = path.join(dir, 'packet.json');
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  const approvalsPath = path.join(dir, 'approvals.jsonl');
  fs.writeFileSync(approvalsPath, `${JSON.stringify(approvalFor(packet, decision))}\n`, 'utf8');
  const dispatchPath = path.join(dir, 'dispatch.jsonl');
  fs.writeFileSync(dispatchPath, dispatches.map(JSON.stringify).join('\n') + (dispatches.length ? '\n' : ''), 'utf8');
  // Audit ledger is always APPROVED (mirrors dispatch.test.mjs runCli: the
  // approvals file carries the decision; BLOCKED_REJECTED comes from it).
  const auditPath = writeAuditLedger(dir, [auditRecordFor(packet)]);
  const flags = ['--send', ...extraFlags];
  if (contactsPath) flags.push('--contacts', contactsPath);
  const result = spawnSync(process.execPath,
    [scriptPath, packetPath, approvalsPath, dispatchPath, auditPath, ...flags],
    { encoding: 'utf8', env: { ...process.env, PATH_SEND_TRANSPORT: 'fake', ...env } });
  return { dir, result, dispatchPath };
}

function makeContactsLedger(dir, records) {
  const contactsPath = path.join(dir, 'contacts.jsonl');
  fs.writeFileSync(contactsPath, records.map((r) => JSON.stringify(r)).join('\n') +
    (records.length ? '\n' : ''), 'utf8');
  return contactsPath;
}

function priorContactRecord(email = 'hm@example.com', channel = 'email') {
  return {
    contactId: 'c-0123456789abcdef',
    name: 'Hiring Manager',
    email,
    channels: [{ channel, address: email, firstSeenAt: '2026-07-29T21:30:00.000Z' }],
    history: [{ event: 'contacted', at: '2026-07-29T21:30:00.000Z', channel, applicationId: 12, source: 'backfill' }],
    lastContactedAt: '2026-07-29T21:30:00.000Z'
  };
}

function nameOnlyRecord(name = 'Hiring Manager', channel = 'linkedin') {
  return {
    contactId: `c-n-${'0'.repeat(16)}`,
    name,
    email: null,
    channels: [{ channel, address: name, firstSeenAt: '2026-07-29T21:30:00.000Z' }],
    history: [{ event: 'contacted', at: '2026-07-29T21:30:00.000Z', channel, applicationId: 12, source: 'backfill' }],
    lastContactedAt: '2026-07-29T21:30:00.000Z'
  };
}

test('--send dispatches an approved packet and appends dispatch_completed', () => {
  const packet = makePacket();
  const { result, dispatchPath } = runSendCli(packet);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.mode, 'send');
  assert.equal(out.status, 'DISPATCHED');
  assert.equal(out.packetId, packet.id);
  assert.equal(out.tier, 'YELLOW');
  assert.match(out.messageId, /^fake-/);

  const lines = fs.readFileSync(dispatchPath, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.packetId, packet.id);
  assert.equal(record.event, 'dispatch_completed');
  assert.equal(record.providerId, 'gmail');
  assert.equal(record.messageId, out.messageId);
});

test('--send passes reply thread metadata to the Gmail transport after approval', () => {
  const packet = makePacket({
    action: {
      type: 'send_email',
      channel: 'email',
      touch: 'reply',
      opportunity: { company: 'Example Company', role: 'AI Engineer' },
      threadId: 'thread-123',
      inReplyTo: '<gmail-message-123@example.test>',
      references: '<root@example.test> <gmail-message-123@example.test>'
    },
    promptVersion: 'path-reply-v1',
    model: 'deterministic-reply-template-v1'
  });
  const { result, dispatchPath } = runSendCli(packet, {
    env: { PATH_SEND_FAKE_ECHO_THREAD: '1' }
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.messageId, 'fake-thread-123-reply-refs');
  const record = JSON.parse(fs.readFileSync(dispatchPath, 'utf8').trim());
  assert.equal(record.messageId, 'fake-thread-123-reply-refs');
});

test('send failure returns SEND_FAILED_* and leaves the ledger untouched', () => {
  const packet = makePacket();
  const { result, dispatchPath } = runSendCli(packet, { env: { PATH_SEND_FAKE_FAIL: '1' } });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'SEND_FAILED_API');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8'), '');
});

test('rejected packet is blocked by the gate before any transport call', () => {
  const packet = makePacket();
  const { result, dispatchPath } = runSendCli(packet, { decision: 'REJECTED' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_REJECTED');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8'), '');
});

test('already-dispatched packet is refused (idempotency)', () => {
  const packet = makePacket();
  const { result, dispatchPath } = runSendCli(packet, {
    dispatches: [{ packetId: packet.id, event: 'dispatch_completed', messageId: 'old' }]
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_ALREADY_DISPATCHED');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8').split(/\r?\n/).filter(Boolean).length, 1);
});

test('--send requires exactly one recognized flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-send-'));
  const packetPath = path.join(dir, 'packet.json');
  fs.writeFileSync(packetPath, JSON.stringify({ id: 'packet-1' }), 'utf8');
  const result = spawnSync(process.execPath, [scriptPath, packetPath], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--send/);
  assert.match(result.stderr, /--dry-run/);
});

test('--contacts blocks re-outreach to an already-contacted address', () => {
  const dir = tempDir();
  const contactsPath = makeContactsLedger(dir, [priorContactRecord()]);
  const packet = makePacket();
  const { result, dispatchPath } = runSendCli(packet, { contactsPath });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_ALREADY_CONTACTED');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8'), '');
});

test('--contacts blocks an already-contacted address in dry-run too', () => {
  const dir = tempDir();
  const contactsPath = makeContactsLedger(dir, [priorContactRecord()]);
  const packet = makePacket();
  const packetPath = path.join(dir, 'packet.json');
  fs.writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
  const approvalsPath = path.join(dir, 'approvals.jsonl');
  fs.writeFileSync(approvalsPath, `${JSON.stringify(approvalFor(packet))}\n`, 'utf8');
  const dispatchPath = path.join(dir, 'dispatch.jsonl');
  fs.writeFileSync(dispatchPath, '', 'utf8');
  const auditPath = writeAuditLedger(dir, [auditRecordFor(packet)]);
  const result = spawnSync(process.execPath,
    [scriptPath, packetPath, approvalsPath, dispatchPath, auditPath, '--dry-run', '--contacts', contactsPath],
    { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_ALREADY_CONTACTED');
});

test('--send with --contacts writes the dispatched contact into the ledger', () => {
  const dir = tempDir();
  const packet = makePacket();
  const contactsPath = path.join(dir, 'contacts.jsonl');
  const { result } = runSendCli(packet, { contactsPath });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'DISPATCHED');
  const lines = fs.readFileSync(contactsPath, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.email, packet.recipient.address);
  assert.equal(record.channels[0].address, packet.recipient.address);
  assert.equal(record.history[0].source, 'dispatch');
  assert.equal(record.history[0].event, 'contacted');
});

test('--contacts blocks a second dispatch to the same person even under a new packet id', () => {
  const dir = tempDir();
  const p1 = makePacket();
  const contactsPath = path.join(dir, 'contacts.jsonl');
  const first = runSendCli(p1, { contactsPath });
  assert.equal(first.result.status, 0);
  const p2 = makePacket({ finalText: 'Follow-up outreach.' });
  const second = runSendCli(p2, { contactsPath });
  assert.equal(second.result.status, 1);
  assert.equal(JSON.parse(second.result.stdout).status, 'BLOCKED_ALREADY_CONTACTED');
});

test('a corrupt contacts ledger blocks as BLOCKED_INVALID_CONTACTS', () => {
  const dir = tempDir();
  const contactsPath = path.join(dir, 'contacts.jsonl');
  fs.writeFileSync(contactsPath, '{not json}\n', 'utf8');
  const packet = makePacket();
  const { result, dispatchPath } = runSendCli(packet, { contactsPath });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_INVALID_CONTACTS');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8'), '');
});

test('channel-scoped dedup — a prior email contact blocks an email dispatch', () => {
  const dir = tempDir();
  const contactsPath = makeContactsLedger(dir, [priorContactRecord('hm@example.com', 'email')]);
  const packet = makePacket(); // action.channel gmail -> canonical email
  const { result, dispatchPath } = runSendCli(packet, { contactsPath });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_ALREADY_CONTACTED');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8'), '');
});

test('channel-scoped dedup — a LinkedIn-only contact does NOT block an email dispatch', () => {
  const dir = tempDir();
  const contactsPath = makeContactsLedger(dir, [priorContactRecord('hm@example.com', 'linkedin')]);
  const packet = makePacket(); // email intent over gmail
  const { result, dispatchPath } = runSendCli(packet, { contactsPath });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'DISPATCHED');
  // Write-back appends the email channel (canonicalized from gmail); the
  // prior LinkedIn event stays first in history.
  const contact = JSON.parse(fs.readFileSync(contactsPath, 'utf8').split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(contact.email, packet.recipient.address);
  assert.equal(contact.history.at(-1).channel, 'email');
  assert.equal(contact.history.at(-1).source, 'dispatch');
  assert.equal(contact.history[0].channel, 'linkedin'); // untouched prior
});

test('channel-scoped dedup — an email contact does NOT block a LinkedIn dispatch (cross-channel)', () => {
  const dir = tempDir();
  const contactsPath = makeContactsLedger(dir, [priorContactRecord('hm@example.com', 'email')]);
  const packet = makeLinkedinPacket(); // action channel linkedin
  const { result, dispatchPath } = runSendCli(packet, { contactsPath });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'DISPATCHED');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8').split(/\r?\n/).filter(Boolean).length, 1);
});

test('channel-scoped dedup — writing back a LinkedIn touch then blocks a second LinkedIn dispatch', () => {
  const dir = tempDir();
  const contactsPath = path.join(dir, 'contacts.jsonl');
  const first = runSendCli(makeLinkedinPacket(), { contactsPath });
  assert.equal(first.result.status, 0, first.result.stdout);
  assert.equal(JSON.parse(first.result.stdout).status, 'DISPATCHED');
  const second = runSendCli(makeLinkedinPacket({ finalText: 'Follow-up outreach.' }), { contactsPath });
  assert.equal(second.result.status, 1);
  assert.equal(JSON.parse(second.result.stdout).status, 'BLOCKED_ALREADY_CONTACTED');
});

test('name-only dedup — a name-only LinkedIn contact blocks a same-channel dispatch', () => {
  const dir = tempDir();
  const contactsPath = makeContactsLedger(dir, [nameOnlyRecord('Hiring Manager', 'linkedin')]);
  const packet = makeLinkedinPacket(); // recipient.name Hire Manager, channel linkedin
  const { result, dispatchPath } = runSendCli(packet, { contactsPath });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_ALREADY_CONTACTED');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8'), '');
});

test('name-only dedup — a name-only LinkedIn contact does NOT block an email dispatch (cross-channel)', () => {
  const dir = tempDir();
  const contactsPath = makeContactsLedger(dir, [nameOnlyRecord('Hiring Manager', 'linkedin')]);
  const packet = makePacket(); // email intent, channel gmail -> email
  const { result, dispatchPath } = runSendCli(packet, { contactsPath });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'DISPATCHED');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8').split(/\r?\n/).filter(Boolean).length, 1);
});

test('name-only dedup — a different recipient name is not blocked', () => {
  const dir = tempDir();
  const contactsPath = makeContactsLedger(dir, [nameOnlyRecord('Someone Else', 'linkedin')]);
  const packet = makePacket(); // recipient.name = Hiring Manager
  const { result, dispatchPath } = runSendCli(packet, { contactsPath });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'DISPATCHED');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8').split(/\r?\n/).filter(Boolean).length, 1);
});

test('name-only dedup — write-back records the fresh channel on the name-only person', () => {
  const dir = tempDir();
  const contactsPath = makeContactsLedger(dir, [nameOnlyRecord('Hiring Manager', 'linkedin')]);
  const packet = makeLinkedinPacket(); // same channel — blocked, so nothing dispatched
  const { result, dispatchPath } = runSendCli(packet, { contactsPath });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'BLOCKED_ALREADY_CONTACTED');
  assert.equal(fs.readFileSync(dispatchPath, 'utf8').length, 0);
});

test('--send routes a linkedin-channel packet to the linkedin transport and records providerId linkedin', () => {
  const packet = makeLinkedinPacket();
  const { result, dispatchPath } = runSendCli(packet);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'DISPATCHED');
  const records = fs.readFileSync(dispatchPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].event, 'dispatch_completed');
  assert.equal(records[0].providerId, 'linkedin');
  assert.match(records[0].messageId, /^fake-linkedin-/);
});

test('--send routes a phone-channel packet to the telephony transport and records providerId telephony', () => {
  const packet = makePacket({ action: {
    type: 'place_call', channel: 'phone', touch: 'first',
    opportunity: { company: 'Example Company', role: 'AI Engineer' }
  } });
  const { result, dispatchPath } = runSendCli(packet);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'DISPATCHED');
  const records = fs.readFileSync(dispatchPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].event, 'dispatch_completed');
  assert.equal(records[0].providerId, 'telephony');
  assert.match(records[0].messageId, /^fake-telephony-/);
});
