import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSchedulerLock, runScheduler } from '../../scripts/path-scheduler.mjs';
import { formatStatus } from '../../scripts/path-scheduler.mjs';

const schedule = {
  version: 'path-schedule-v1', timezone: 'America/New_York', lockTtlMinutes: 60,
  jobs: { followup: { enabled: true, everyHours: 24, command: ['node', 'followup-cadence.mjs', '--json'], mode: 'review_only' } },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'path-scheduler-'));
  const configPath = join(root, 'schedule.json');
  const statePath = join(root, 'state.json');
  const logPath = join(root, 'runs.jsonl');
  writeFileSync(configPath, JSON.stringify(schedule));
  return { root, configPath, statePath, logPath };
}

test('runScheduler dry-run reports due work without writing state or logs', async () => {
  const paths = fixture();
  const result = await runScheduler({ ...paths, dryRun: true, now: '2026-08-21T12:00:00.000Z' });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.jobs.map(job => job.name), ['followup']);
  assert.equal(existsSync(paths.statePath), false);
  assert.equal(existsSync(paths.logPath), false);
});

test('runScheduler once records a successful local job and updates state', async () => {
  const paths = fixture();
  const result = await runScheduler({
    ...paths,
    now: '2026-08-21T12:00:00.000Z',
    runCommand: async () => ({ exitCode: 0, stdout: '{"entries":[]}', stderr: '' }),
  });
  assert.equal(result.mode, 'once');
  assert.equal(result.events[0].status, 'success');
  const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
  assert.equal(state.jobs.followup.lastCompletedAt, '2026-08-21T12:00:00.000Z');
  assert.equal(readFileSync(paths.logPath, 'utf8').trim().split('\n').length, 1);
});

test('runScheduler records blocked commands without invoking them', async () => {
  const paths = fixture();
  const blocked = { ...schedule, jobs: { send: { enabled: true, everyHours: 1, command: ['node', 'scripts/path-dispatch.mjs', '--send'], mode: 'review_only' } } };
  writeFileSync(paths.configPath, JSON.stringify(blocked));
  let invoked = false;
  const result = await runScheduler({ ...paths, runCommand: async () => { invoked = true; return { exitCode: 0 }; } });
  assert.equal(invoked, false);
  assert.equal(result.events[0].status, 'blocked');
  assert.equal(result.events[0].reasonCode, 'BLOCKED_SEND_FLAG');
});

test('formatStatus includes next due time and last error per job', async () => {
  const paths = fixture();
  await runScheduler({
    ...paths,
    now: '2026-08-21T12:00:00.000Z',
    runCommand: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }),
  });

  const status = formatStatus({
    ...paths,
    now: '2026-08-21T13:00:00.000Z',
    lockPath: join(paths.root, 'runtime', 'scheduler.lock'),
  });

  assert.equal(status.jobs.followup.lastStatus, 'success');
  assert.equal(status.jobs.followup.nextDueAt, '2026-08-22T12:00:00.000Z');
  assert.equal(status.jobs.followup.lastError, null);
});

test('scheduler lock acquisition is atomic for competing runs', () => {
  const paths = fixture();
  const lockPath = join(paths.root, 'runtime', 'scheduler.lock');
  assert.equal(acquireSchedulerLock(lockPath, { runId: 'a', acquiredAt: '2026-08-21T12:00:00.000Z' }), true);
  assert.equal(acquireSchedulerLock(lockPath, { runId: 'b', acquiredAt: '2026-08-21T12:00:01.000Z' }), false);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), { runId: 'a', acquiredAt: '2026-08-21T12:00:00.000Z' });
});

test('after-command policy failures are attributed to the actual blocked command', async () => {
  const paths = fixture();
  const withAfter = {
    ...schedule,
    jobs: {
      followup: {
        ...schedule.jobs.followup,
        after: [['node', 'reply-watch.mjs']],
      },
    },
  };
  writeFileSync(paths.configPath, JSON.stringify(withAfter));
  const result = await runScheduler({ ...paths, runCommand: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) });
  assert.equal(result.events[0].status, 'blocked');
  assert.equal(result.events[0].reasonCode, 'BLOCKED_INTERACTIVE_COMMAND');
  assert.deepEqual(result.events[0].command, ['node', 'reply-watch.mjs']);
});
