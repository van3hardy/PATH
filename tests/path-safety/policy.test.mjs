import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAction } from '../../path-safety/policy.mjs';

test('discovery is GREEN', () => {
  const result = classifyAction({ type: 'discover_roles', channel: 'internal' });
  assert.equal(result.tier, 'GREEN');
  assert.deepEqual(result.reasons, ['discovery is allowed automatically']);
});

test('first-touch email is YELLOW', () => {
  const result = classifyAction({ type: 'send_email', channel: 'gmail', touch: 'first' });
  assert.equal(result.tier, 'YELLOW');
  assert.ok(result.reasons.includes('first-touch sends require Van approval'));
});

test('salary commitment is RED', () => {
  const result = classifyAction({
    type: 'send_email',
    channel: 'gmail',
    text: 'I will accept $160,000 base salary.'
  });
  assert.equal(result.tier, 'RED');
  assert.ok(result.reasons.includes('salary or compensation commitment is manual-only'));
});

test('unsupported binding commitment is RED', () => {
  const result = classifyAction({
    type: 'send_linkedin',
    channel: 'linkedin',
    text: 'I can start Monday and I accept the offer.'
  });
  assert.equal(result.tier, 'RED');
  assert.ok(result.reasons.includes('binding commitment is manual-only'));
});

test('place_call is YELLOW', () => {
  const result = classifyAction({ type: 'place_call', channel: 'phone', touch: 'first' });
  assert.equal(result.tier, 'YELLOW');
  assert.ok(result.reasons.includes('place call requires Van approval'));
});
