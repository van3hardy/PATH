import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFacts, resolveClaims } from '../../path-safety/fact-resolver.mjs';

test('known facts are supported', () => {
  const facts = loadFacts('config/path.facts.yml');
  const result = resolveClaims('Van builds agent workflows on Windows 11 with PowerShell.', facts);
  assert.deepEqual(result.supported, ['Van builds agent workflows on Windows 11 with PowerShell.']);
  assert.deepEqual(result.unsupported, []);
});

test('unknown claims are unsupported', () => {
  const facts = loadFacts('config/path.facts.yml');
  const result = resolveClaims('Van led recruiting at a Fortune 100 company.', facts);
  assert.deepEqual(result.supported, []);
  assert.deepEqual(result.unsupported, ['Van led recruiting at a Fortune 100 company.']);
});
