import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApprovalPacket } from '../../path-safety/approval-packet.mjs';
import { loadFacts } from '../../path-safety/fact-resolver.mjs';

test('YELLOW email gets approval packet with facts and final text', () => {
  const packet = buildApprovalPacket({
    action: { type: 'send_email', channel: 'gmail', touch: 'first' },
    recipient: { name: 'Hiring Manager', channel: 'gmail', address: 'hm@example.com' },
    text: 'Van builds agent workflows on Windows 11 with PowerShell.',
    facts: loadFacts('config/path.facts.yml'),
    promptVersion: 'path-recruiter-v1',
    model: 'test-model'
  });

  assert.equal(packet.tier, 'YELLOW');
  assert.equal(packet.status, 'AWAITING_VAN_APPROVAL');
  assert.equal(packet.recipient.address, 'hm@example.com');
  assert.deepEqual(packet.unsupportedClaims, []);
  assert.equal(packet.finalText, 'Van builds agent workflows on Windows 11 with PowerShell.');
});
