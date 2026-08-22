import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('followup-cadence --json emits structured analysis without tracker writes', () => {
  const tracker = join(ROOT, 'data', 'applications.md');
  // Fresh clones do not ship the user-layer tracker. When it exists, retain
  // the no-write assertion; otherwise the CLI must still prove it degrades to
  // an empty structured result without requiring onboarding data.
  const before = existsSync(tracker) ? readFileSync(tracker, 'utf8') : null;
  const run = spawnSync(process.execPath, ['followup-cadence.mjs', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
  const result = JSON.parse(run.stdout);
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0);
  assert.ok(result.metadata);
  assert.deepEqual(result.entries, []);
  if (before !== null) assert.equal(readFileSync(tracker, 'utf8'), before);
});

test('followup-cadence rejects unknown flags', () => {
  const run = spawnSync(process.execPath, ['followup-cadence.mjs', '--json', '--send'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unrecognized flag/i);
});
