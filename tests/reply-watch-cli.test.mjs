import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('reply-watch --no-apply --json emits JSON without prompting or mutating the tracker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'path-reply-watch-'));
  const candidates = join(dir, 'candidates.json');
  writeFileSync(candidates, JSON.stringify([{
    message_id: 'msg-unmatched',
    from: 'recruiter@example.com',
    subject: 'Application update',
    body_snippet: 'Please review this update',
  }]));
  const tracker = join(ROOT, 'data', 'applications.md');
  const before = existsSync(tracker) ? readFileSync(tracker, 'utf8') : null;
  const stdout = execFileSync(process.execPath, ['reply-watch.mjs', '--no-apply', '--json', candidates], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.deepEqual(JSON.parse(stdout), { recommendations: [], conflicts: [], matched: 1 });
  if (before !== null) assert.equal(readFileSync(tracker, 'utf8'), before);
});

test('reply-watch --no-apply --json does not create mock candidates when the file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'path-reply-watch-missing-'));
  const candidates = join(dir, 'missing-candidates.json');
  const tracker = join(ROOT, 'data', 'applications.md');
  const before = existsSync(tracker) ? readFileSync(tracker, 'utf8') : null;
  const stdout = execFileSync(process.execPath, ['reply-watch.mjs', '--no-apply', '--json', candidates], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.deepEqual(JSON.parse(stdout), {
    recommendations: [],
    conflicts: [],
    matched: 0,
    sourceMissing: true,
    sourcePath: candidates,
  });
  assert.equal(existsSync(candidates), false);
  if (before !== null) assert.equal(readFileSync(tracker, 'utf8'), before);
});
