import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPacketIntegrityFields,
  stableStringify,
  verifyPacketIntegrity
} from '../../path-safety/packet-integrity.mjs';

const base = {
  action: {
    type: 'send_email', channel: 'email', touch: 'first',
    opportunity: { company: 'Example Company', role: 'AI Engineer' }
  },
  recipient: { name: 'Hiring Manager', address: 'hm@example.test' },
  finalText: '<complete deterministic recruiter draft>',
  evidenceIds: ['fact-agent-workflows'],
  evidenceHashes: ['a'.repeat(64)],
  claimReportHash: 'b'.repeat(64),
  voiceProfile: 'path-recruiter-persistent-respectful-v1',
  disclosurePolicy: 'always-disclose-ai-assistance-v1',
  disclosureIncluded: true,
  promptVersion: 'path-recruiter-v1',
  provider: 'fake',
  model: 'deterministic-recruiter-template-v1',
  policyVersion: 'path-safety-v1',
  createdAt: '2026-07-29T12:00:00.000Z',
  expiresAt: '2026-07-30T12:00:00.000Z'
};

function makePacket(overrides = {}) {
  const candidate = { ...base, ...overrides };
  return { ...candidate, ...buildPacketIntegrityFields(candidate) };
}

test('stableStringify sorts object keys recursively', () => {
  assert.equal(stableStringify({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});

test('integrity binds evidence and destination', () => {
  const packet = { ...base, ...buildPacketIntegrityFields(base) };
  assert.deepEqual(verifyPacketIntegrity(packet, { now: new Date('2026-07-29T13:00:00Z') }), {
    ok: true,
    code: 'INTEGRITY_OK'
  });
  const altered = { ...packet, recipient: { ...packet.recipient, address: 'other@example.test' } };
  assert.deepEqual(verifyPacketIntegrity(altered, { now: new Date('2026-07-29T13:00:00Z') }), {
    ok: false,
    code: 'BLOCKED_INTEGRITY_MISMATCH'
  });
});

test('expired packet is blocked', () => {
  const packet = { ...base, ...buildPacketIntegrityFields(base) };
  assert.deepEqual(verifyPacketIntegrity(packet, { now: new Date('2026-07-30T12:00:00.001Z') }), {
    ok: false,
    code: 'BLOCKED_EXPIRED'
  });
});

test('self-consistently hashed empty packet fields are structurally invalid', () => {
  const packet = makePacket({
    status: 'AWAITING_VAN_APPROVAL',
    tier: 'YELLOW',
    action: {},
    recipient: {},
    finalText: ''
  });
  assert.deepEqual(verifyPacketIntegrity(packet, {
    now: new Date('2026-07-29T13:00:00Z')
  }), { ok: false, code: 'BLOCKED_INVALID_PACKET' });
});

test('packet structure enforces every locked integrity binding', () => {
  const malformed = [
    ['action type', { action: { type: '', channel: 'email', touch: 'first' } }],
    ['action channel', { action: { type: 'send_email', channel: '', touch: 'first' } }],
    ['yellow touch', { tier: 'YELLOW', action: {
      type: 'send_email', channel: 'email', touch: '',
      opportunity: { company: 'Example Company', role: 'AI Engineer' }
    } }],
    ['yellow opportunity', { tier: 'YELLOW', action: {
      type: 'send_email', channel: 'email', touch: 'first'
    } }],
    ['recipient name', { recipient: { name: '', address: 'hm@example.test' } }],
    ['recipient address', { recipient: { name: 'Hiring Manager', address: '' } }],
    ['final text', { finalText: ' ' }],
    ['evidence lengths', { evidenceIds: ['fact-1'], evidenceHashes: [] }],
    ['evidence id', { evidenceIds: [''], evidenceHashes: ['a'.repeat(64)] }],
    ['evidence hash', { evidenceHashes: ['not-a-hash'] }],
    ['claim report hash', { claimReportHash: 'not-a-hash' }],
    ['voice profile', { voiceProfile: 'unknown' }],
    ['disclosure policy', { disclosurePolicy: 'unknown' }],
    ['disclosure inclusion', { disclosureIncluded: false }],
    ['prompt version', { promptVersion: 'unknown' }],
    ['provider', { provider: 'unknown' }],
    ['model', { model: 'unknown' }],
    ['policy version', { policyVersion: 'unknown' }],
    ['created timestamp', { createdAt: 'not-a-date' }],
    ['expiry timestamp', { expiresAt: 'not-a-date' }],
    ['exact 24-hour expiry', { expiresAt: '2026-07-30T11:59:59.999Z' }]
  ];

  for (const [name, overrides] of malformed) {
    const packet = makePacket(overrides);
    assert.deepEqual(verifyPacketIntegrity(packet, {
      now: new Date('2026-07-29T13:00:00Z')
    }), { ok: false, code: 'BLOCKED_INVALID_PACKET' }, name);
  }

  const malformedHashFields = [
    ['packet id', { id: 'not-an-id' }],
    ['integrity hash', { integritySha256: 'not-a-hash' }],
    ['idempotency key', { idempotencyKey: 'not-a-key' }]
  ];
  const valid = makePacket();
  for (const [name, overrides] of malformedHashFields) {
    assert.deepEqual(verifyPacketIntegrity({ ...valid, ...overrides }, {
      now: new Date('2026-07-29T13:00:00Z')
    }), { ok: false, code: 'BLOCKED_INVALID_PACKET' }, name);
  }
});
