import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApprovalPacket } from '../../path-safety/approval-packet.mjs';
import { loadFacts } from '../../path-safety/fact-resolver.mjs';
import { verifyPacketIntegrity } from '../../path-safety/packet-integrity.mjs';

const approvedSentence = 'Van builds agent workflows on Windows 11 with PowerShell.';

function supportedInput(overrides = {}) {
  return {
    action: { type: 'send_email', channel: 'gmail', touch: 'first' },
    opportunity: { company: 'Example Company', role: 'AI Engineer' },
    recipient: { name: 'Hiring Manager', channel: 'gmail', address: 'hm@example.com' },
    text: `Hello. ${approvedSentence} Path is Van's AI recruiting assistant.`,
    claims: [approvedSentence],
    facts: loadFacts('config/path.facts.yml'),
    evidenceIds: ['van-agent-workflows-windows-powershell'],
    evidenceHashes: ['a'.repeat(64)],
    claimReportHash: 'b'.repeat(64),
    voiceProfile: 'path-recruiter-persistent-respectful-v1',
    disclosurePolicy: 'always-disclose-ai-assistance-v1',
    disclosureIncluded: true,
    promptVersion: 'path-recruiter-v1',
    provider: 'fake',
    model: 'deterministic-recruiter-template-v1',
    ...overrides
  };
}

test('YELLOW email gets an integrity-bound approval packet', () => {
  const packet = buildApprovalPacket(supportedInput(), {
    now: () => new Date('2026-07-29T12:00:00.000Z')
  });

  assert.equal(packet.tier, 'YELLOW');
  assert.equal(packet.status, 'AWAITING_VAN_APPROVAL');
  assert.equal(packet.recipient.address, 'hm@example.com');
  assert.deepEqual(packet.unsupportedClaims, []);
  assert.equal(packet.finalText, `Hello. ${approvedSentence} Path is Van's AI recruiting assistant.`);
  assert.equal(packet.policyVersion, 'path-safety-v1');
  assert.equal(packet.voiceProfile, 'path-recruiter-persistent-respectful-v1');
  assert.equal(packet.disclosurePolicy, 'always-disclose-ai-assistance-v1');
  assert.equal(packet.disclosureIncluded, true);
  assert.equal(packet.createdAt, '2026-07-29T12:00:00.000Z');
  assert.equal(packet.expiresAt, '2026-07-30T12:00:00.000Z');
  assert.match(packet.integritySha256, /^[a-f0-9]{64}$/);
  assert.match(packet.idempotencyKey, /^[a-f0-9]{24}$/);
  assert.equal(packet.id, packet.integritySha256.slice(0, 16));
  assert.deepEqual(packet.action.opportunity, {
    company: 'Example Company', role: 'AI Engineer'
  });
  assert.deepEqual(verifyPacketIntegrity(packet, {
    now: new Date('2026-07-29T12:00:00.000Z')
  }), { ok: true, code: 'INTEGRITY_OK' });
});

test('invalid evidence bindings fail closed with a stable packet code', () => {
  const cases = [
    ['omitted ids', { evidenceIds: undefined }],
    ['null ids', { evidenceIds: null }],
    ['scalar ids', { evidenceIds: 'fact-1' }],
    ['empty evidence', { evidenceIds: [], evidenceHashes: [] }],
    ['unequal evidence', { evidenceHashes: [] }],
    ['invalid evidence hash', { evidenceHashes: ['not-a-hash'] }]
  ];
  for (const [name, overrides] of cases) {
    assert.throws(() => buildApprovalPacket(supportedInput(overrides)), {
      code: 'BLOCKED_INVALID_PACKET'
    }, name);
  }
});

test('top-level opportunity controls the canonical packet action', () => {
  const packet = buildApprovalPacket(supportedInput());
  assert.deepEqual(packet.action.opportunity, supportedInput().opportunity);

  const nestedOnlyInput = supportedInput({ opportunity: undefined });
  nestedOnlyInput.action = {
    ...nestedOnlyInput.action,
    opportunity: { company: 'Nested Company', role: 'Platform Engineer' }
  };
  const nestedOnly = buildApprovalPacket(nestedOnlyInput);
  assert.deepEqual(nestedOnly.action.opportunity, nestedOnlyInput.action.opportunity);

  const matchingDual = supportedInput();
  matchingDual.action = { ...matchingDual.action, opportunity: matchingDual.opportunity };
  assert.deepEqual(buildApprovalPacket(matchingDual).action.opportunity, matchingDual.opportunity);
});

test('YELLOW packets reject missing or conflicting opportunity bindings', () => {
  const cases = [];
  const missing = supportedInput({ opportunity: undefined });
  cases.push(['missing opportunity', missing]);
  cases.push(['missing touch', supportedInput({
    action: { type: 'send_email', channel: 'gmail' }
  })]);
  cases.push(['missing company', supportedInput({ opportunity: { company: '', role: 'AI Engineer' } })]);
  cases.push(['missing role', supportedInput({ opportunity: { company: 'Example Company', role: '' } })]);
  const mismatch = supportedInput();
  mismatch.action = {
    ...mismatch.action,
    opportunity: { company: 'Other Company', role: 'AI Engineer' }
  };
  cases.push(['dual mismatch', mismatch]);

  for (const [name, input] of cases) {
    assert.throws(() => buildApprovalPacket(input), {
      code: 'BLOCKED_INVALID_PACKET'
    }, name);
  }
});

test('opportunity changes both integrity and idempotency bindings', () => {
  const first = buildApprovalPacket(supportedInput(), {
    now: () => new Date('2026-07-29T12:00:00.000Z')
  });
  const second = buildApprovalPacket(supportedInput({
    opportunity: { company: 'Other Company', role: 'AI Engineer' }
  }), { now: () => new Date('2026-07-29T12:00:00.000Z') });
  assert.notEqual(first.integritySha256, second.integritySha256);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);

  const tampered = {
    ...first,
    action: {
      ...first.action,
      opportunity: { ...first.action.opportunity, company: 'Tampered Company' }
    }
  };
  assert.deepEqual(verifyPacketIntegrity(tampered), {
    ok: false, code: 'BLOCKED_INTEGRITY_MISMATCH'
  });
});

test('missing claims blocks instead of resolving complete template text', () => {
  assert.throws(() => buildApprovalPacket(supportedInput({ claims: undefined })), {
    code: 'BLOCKED_INVALID_CLAIMS'
  });
});

test('a multi-sentence declared claim is rejected as non-atomic', () => {
  assert.throws(() => buildApprovalPacket(supportedInput({
    claims: [`${approvedSentence} Another sentence.`]
  })), { code: 'BLOCKED_INVALID_CLAIMS' });
});

test('missing disclosure binding blocks packet construction', () => {
  assert.throws(() => buildApprovalPacket(supportedInput({ disclosureIncluded: false })), {
    code: 'BLOCKED_INVALID_DISCLOSURE_POLICY'
  });
});

test('unsupported claims throw only count and hashes without a packet', () => {
  assert.throws(() => buildApprovalPacket(supportedInput({
    claims: ['Van led recruiting at a Fortune 100 company.']
  })), (error) => {
    assert.equal(error.code, 'BLOCKED_UNSUPPORTED_CLAIMS');
    assert.equal(error.unsupportedCount, 1);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'unsupportedCount', 'unsupportedHashes']);
    assert.match(error.unsupportedHashes[0], /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(error), /Fortune 100/);
    return true;
  });
});

test('invalid YELLOW recruiter context blocks before unsupported-claim handling', () => {
  const unsupportedClaim = ['Van led recruiting at a Fortune 100 company.'];
  const missingOpportunity = supportedInput({
    opportunity: undefined,
    claims: unsupportedClaim
  });
  const missingTouch = supportedInput({
    action: { type: 'send_email', channel: 'gmail' },
    claims: unsupportedClaim
  });
  const conflicting = supportedInput({ claims: unsupportedClaim });
  conflicting.action = {
    ...conflicting.action,
    opportunity: { company: 'Other Company', role: 'AI Engineer' }
  };

  for (const [name, input] of [
    ['missing opportunity', missingOpportunity],
    ['missing touch', missingTouch],
    ['conflicting opportunity', conflicting]
  ]) {
    assert.throws(() => buildApprovalPacket(input), {
      code: 'BLOCKED_INVALID_PACKET'
    }, name);
  }
});
