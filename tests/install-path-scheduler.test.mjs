import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('Task Scheduler installer has a safe WhatIf path and never embeds credentials', () => {
  const script = readFileSync(join(ROOT, 'scripts', 'install-path-scheduler.ps1'), 'utf8');
  assert.match(script, /param\s*\(/i);
  assert.match(script, /WhatIf/i);
  assert.match(script, /--once/);
  assert.match(script, /Register-ScheduledTask/);
  assert.match(script, /Unregister-ScheduledTask/);
  assert.match(script, /path-scheduler\.out\.log/);
  assert.match(script, /path-scheduler\.err\.log/);
  assert.match(script, /1>>/);
  assert.match(script, /2>>/);
  assert.doesNotMatch(script, /GMAIL_CLIENT_SECRET\s*=/i);
});
