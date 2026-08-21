import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvent,
  classifyCommand,
  evaluateLock,
  getDueJobs,
  validateSchedule,
} from '../../scripts/path-scheduler-core.mjs';

const VALID_SCHEDULE = {
  version: 'path-schedule-v1',
  timezone: 'America/New_York',
  lockTtlMinutes: 60,
  jobs: {
    scan: {
      enabled: true,
      everyHours: 72,
      command: ['node', 'scan.mjs'],
      mode: 'local_write_only',
    },
    followup: {
      enabled: true,
      everyHours: 24,
      command: ['node', 'followup-cadence.mjs', '--json'],
      mode: 'review_only',
    },
    reply_watch: {
      enabled: true,
      everyHours: 2,
      command: ['node', 'gmail-scan-replies.mjs', '--days', '7'],
      after: [['node', 'reply-watch.mjs', '--no-apply', '--json']],
      mode: 'review_only',
    },
  },
};

test('validateSchedule normalizes the approved Phase 4 schedule shape', () => {
  const normalized = validateSchedule(VALID_SCHEDULE);
  assert.equal(normalized.version, 'path-schedule-v1');
  assert.equal(normalized.timezone, 'America/New_York');
  assert.equal(normalized.lockTtlMinutes, 60);
  assert.deepEqual(Object.keys(normalized.jobs), ['scan', 'followup', 'reply_watch']);
  assert.deepEqual(normalized.jobs.reply_watch.after, [
    ['node', 'reply-watch.mjs', '--no-apply', '--json'],
  ]);
});

test('validateSchedule rejects malformed job definitions', () => {
  assert.throws(() => validateSchedule({
    version: 'path-schedule-v1',
    timezone: 'America/New_York',
    lockTtlMinutes: 60,
    jobs: {
      scan: {
        enabled: true,
        everyHours: 0,
        command: 'node scan.mjs',
        mode: 'local_write_only',
      },
    },
  }), /Invalid schedule/);
  assert.throws(() => validateSchedule({
    ...VALID_SCHEDULE,
    jobs: { reply_watch: { ...VALID_SCHEDULE.jobs.reply_watch, after: 'node reply-watch.mjs' } },
  }), /Invalid schedule/);
});

test('getDueJobs returns enabled due jobs and skips disabled or not-yet-due jobs', () => {
  const schedule = validateSchedule({
    ...VALID_SCHEDULE,
    jobs: {
      ...VALID_SCHEDULE.jobs,
      reply_watch: {
        ...VALID_SCHEDULE.jobs.reply_watch,
        enabled: false,
      },
    },
  });
  const now = '2026-08-21T12:00:00.000Z';
  const state = {
    jobs: {
      scan: { lastCompletedAt: '2026-08-17T11:59:00.000Z' },
      followup: { lastCompletedAt: '2026-08-21T02:00:00.000Z' },
      reply_watch: { lastCompletedAt: '2026-08-21T10:30:00.000Z' },
    },
  };

  const dueJobs = getDueJobs(schedule, state, now);

  assert.equal(dueJobs.length, 1);
  assert.equal(dueJobs[0].name, 'scan');
  assert.equal(dueJobs[0].reasonCode, 'DUE');
  assert.equal(dueJobs[0].nextDueAt, '2026-08-20T11:59:00.000Z');
});

test('getDueJobs can force a named job even when it is not due', () => {
  const schedule = validateSchedule(VALID_SCHEDULE);
  const dueJobs = getDueJobs(schedule, {
    jobs: {
      followup: { lastCompletedAt: '2026-08-21T11:00:00.000Z' },
    },
  }, '2026-08-21T12:00:00.000Z', { jobName: 'followup', force: true });

  assert.equal(dueJobs.length, 1);
  assert.equal(dueJobs[0].name, 'followup');
  assert.equal(dueJobs[0].reasonCode, 'FORCED');
});

test('evaluateLock reports available, locked, and stale lock states', () => {
  assert.deepEqual(evaluateLock(null, '2026-08-21T12:00:00.000Z', 60), {
    state: 'AVAILABLE',
    reasonCode: 'LOCK_AVAILABLE',
  });

  assert.deepEqual(evaluateLock({
    runId: 'run-1',
    acquiredAt: '2026-08-21T11:30:00.000Z',
  }, '2026-08-21T12:00:00.000Z', 60), {
    state: 'LOCKED',
    reasonCode: 'LOCK_ACTIVE',
    runId: 'run-1',
    expiresAt: '2026-08-21T12:30:00.000Z',
  });

  assert.deepEqual(evaluateLock({
    runId: 'run-2',
    acquiredAt: '2026-08-21T10:30:00.000Z',
  }, '2026-08-21T12:00:00.000Z', 60), {
    state: 'STALE_RECLAIMABLE',
    reasonCode: 'LOCK_STALE',
    runId: 'run-2',
    expiresAt: '2026-08-21T11:30:00.000Z',
  });
});

test('classifyCommand allows approved local commands and blocks consequential ones', () => {
  assert.deepEqual(classifyCommand(['node', 'reply-watch.mjs', '--no-apply', '--json']), {
    allowed: true,
    reasonCode: 'ALLOW_REVIEW_ONLY',
    script: 'reply-watch.mjs',
  });

  assert.deepEqual(classifyCommand(['node', 'scripts/path-dispatch.mjs', '--send']), {
    allowed: false,
    reasonCode: 'BLOCKED_SEND_FLAG',
    script: 'path-dispatch.mjs',
  });

  assert.deepEqual(classifyCommand(['node', 'transports/gmail-send.mjs']), {
    allowed: false,
    reasonCode: 'BLOCKED_DIRECT_GMAIL_SEND',
    script: 'gmail-send.mjs',
  });

  assert.deepEqual(classifyCommand(['browser.submit']), {
    allowed: false,
    reasonCode: 'BLOCKED_CONSEQUENTIAL_ACTION',
    script: 'browser.submit',
  });

  assert.deepEqual(classifyCommand(['python', 'custom-job.py']), {
    allowed: false,
    reasonCode: 'BLOCKED_UNKNOWN_COMMAND',
    script: 'custom-job.py',
  });
});

test('classifyCommand blocks interactive reply-watch and headed browser scans', () => {
  assert.deepEqual(classifyCommand(['node', 'reply-watch.mjs']), {
    allowed: false,
    reasonCode: 'BLOCKED_INTERACTIVE_COMMAND',
    script: 'reply-watch.mjs',
  });
  assert.deepEqual(classifyCommand(['node', 'scan.mjs', '--headed-fallback']), {
    allowed: false,
    reasonCode: 'BLOCKED_HEADED_BROWSER',
    script: 'scan.mjs',
  });
});

test('buildEvent returns a stable append-only event payload', () => {
  const event = buildEvent({
    runId: 'run-123',
    jobName: 'followup',
    status: 'blocked',
    reasonCode: 'BLOCKED_SEND_FLAG',
    command: ['node', 'scripts/path-dispatch.mjs', '--send'],
    startedAt: '2026-08-21T12:00:00.000Z',
    finishedAt: '2026-08-21T12:00:01.000Z',
  });

  assert.deepEqual(event, {
    runId: 'run-123',
    job: 'followup',
    status: 'blocked',
    reasonCode: 'BLOCKED_SEND_FLAG',
    command: ['node', 'scripts/path-dispatch.mjs', '--send'],
    startedAt: '2026-08-21T12:00:00.000Z',
    finishedAt: '2026-08-21T12:00:01.000Z',
  });
});
