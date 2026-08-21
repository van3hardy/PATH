import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScheduler } from '../../scripts/path-scheduler.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'path-scheduler-e2e-'));
  const configPath = join(root, 'schedule.json');
  writeFileSync(configPath, JSON.stringify({
    version: 'path-schedule-v1', timezone: 'America/New_York', lockTtlMinutes: 60,
    jobs: {
      scan: { enabled: true, everyHours: 72, command: ['node', 'scan.mjs'], mode: 'local_write_only' },
      followup: { enabled: true, everyHours: 24, command: ['node', 'followup-cadence.mjs', '--json'], mode: 'review_only' },
      reply_watch: { enabled: true, everyHours: 2, command: ['node', 'gmail-scan-replies.mjs', '--days', '7'], after: [['node', 'reply-watch.mjs', '--no-apply', '--json']], mode: 'review_only' },
    },
  }));
  return { root, configPath, statePath: join(root, 'state.json'), logPath: join(root, 'runs.jsonl') };
}

test('fake scheduled run executes scan, follow-up, and reply-watch without dispatch', async () => {
  const paths = fixture();
  const commands = [];
  const result = await runScheduler({
    ...paths,
    now: '2026-08-21T12:00:00.000Z',
    runCommand: async command => {
      commands.push(command);
      return { exitCode: 0, stdout: '{}', stderr: '' };
    },
  });
  assert.deepEqual(result.events.map(event => event.status), ['success', 'success', 'success']);
  assert.equal(commands.some(command => command.includes('--send')), false);
  assert.equal(commands.filter(command => command[1] === 'reply-watch.mjs').length, 1);
  assert.equal(readFileSync(paths.logPath, 'utf8').trim().split('\n').length, 3);
  const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
  assert.equal(state.jobs.reply_watch.lastStatus, 'success');
});

test('active lock makes a concurrent scheduler run skip without running commands', async () => {
  const paths = fixture();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const first = runScheduler({ ...paths, now: '2026-08-21T12:00:00.000Z', runCommand: async () => { await hold; return { exitCode: 0 }; } });
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = await runScheduler({ ...paths, now: '2026-08-21T12:00:01.000Z', runCommand: async () => { throw new Error('must not run'); } });
  assert.equal(second.events[0].reasonCode, 'LOCK_ACTIVE');
  release();
  const firstResult = await first;
  assert.equal(firstResult.events[0].status, 'success');
});
