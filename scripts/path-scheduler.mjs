#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import {
  buildEvent, classifyCommand, evaluateLock, getDueJobs, validateSchedule,
} from './path-scheduler-core.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

/** Acquire a scheduler lock without allowing competing processes to overwrite it. */
export function acquireSchedulerLock(lockPath, lockRecord) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(lockRecord, null, 2)}\n`, 'utf8');
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
      try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
    }
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function appendEvent(filePath, event) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

function loadSchedule(configPath) {
  if (!fs.existsSync(configPath)) throw new Error(`Schedule config not found: ${configPath}`);
  const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
  return validateSchedule(parsed);
}

async function defaultRunCommand(command, { cwd }) {
  try {
    const result = await execFileAsync(command[0], command.slice(1), { cwd, encoding: 'utf8' });
    return { exitCode: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    return { exitCode: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || error.message };
  }
}

export async function runScheduler({
  root = ROOT,
  configPath = path.join(root, 'config', 'path.schedule.yml'),
  statePath = path.join(root, 'data', 'path-scheduler-state.json'),
  logPath = path.join(root, 'data', 'path-scheduler-runs.jsonl'),
  lockPath = path.join(root, '.path-runtime', 'path-scheduler.lock'),
  now = new Date().toISOString(),
  dryRun = false,
  jobName,
  force = false,
  runCommand = defaultRunCommand,
} = {}) {
  const schedule = loadSchedule(configPath);
  const state = readJson(statePath, { version: 'path-scheduler-state-v1', jobs: {} });
  const lock = readJson(lockPath, null);
  const lockStatus = evaluateLock(lock, now, schedule.lockTtlMinutes);
  const jobs = getDueJobs(schedule, state, now, { jobName, force });
  if (dryRun) return { mode: 'dry-run', jobs, lock: lockStatus };
  if (lockStatus.state === 'LOCKED') {
    const event = buildEvent({ runId: randomUUID(), jobName: jobName || '*', status: 'skipped', reasonCode: 'LOCK_ACTIVE', command: [], startedAt: now, finishedAt: now });
    appendEvent(logPath, event);
    return { mode: 'once', jobs: [], events: [event], lock: lockStatus };
  }

  const runId = randomUUID();
  if (lockStatus.state === 'STALE_RECLAIMABLE' && lock) {
    const currentLock = readJson(lockPath, null);
    if (currentLock && currentLock.runId === lock.runId && currentLock.acquiredAt === lock.acquiredAt) {
      try { fs.unlinkSync(lockPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  if (!acquireSchedulerLock(lockPath, { runId, acquiredAt: now })) {
    const event = buildEvent({ runId, jobName: jobName || '*', status: 'skipped', reasonCode: 'LOCK_RACE', command: [], startedAt: now, finishedAt: now });
    appendEvent(logPath, event);
    return { mode: 'once', jobs: [], events: [event], lock: evaluateLock(readJson(lockPath, null), now, schedule.lockTtlMinutes) };
  }
  const events = [];
  const nextState = { ...state, version: 'path-scheduler-state-v1', jobs: { ...(state.jobs || {}) } };
  try {
    for (const job of jobs) {
      const startedAt = new Date().toISOString();
      const commands = [job.command, ...job.after];
      let status = 'success';
      let reasonCode = 'JOB_COMPLETED';
      let failureMessage = null;
      let executedCommand = job.command;
      for (const command of commands) {
        executedCommand = command;
        const policy = classifyCommand(command);
        if (!policy.allowed) {
          status = 'blocked';
          reasonCode = policy.reasonCode;
          break;
        }
        const result = await runCommand(command, { cwd: root, job });
        if (result.exitCode !== 0) {
          status = 'failed';
          reasonCode = 'JOB_FAILED';
          failureMessage = result.stderr || `exit ${result.exitCode}`;
          break;
        }
      }
      const finishedAt = new Date().toISOString();
      const event = buildEvent({ runId, jobName: job.name, status, reasonCode, command: executedCommand, startedAt, finishedAt });
      if (failureMessage) event.error = failureMessage;
      events.push(event);
      appendEvent(logPath, event);
      const prior = nextState.jobs[job.name] || {};
      nextState.jobs[job.name] = {
        ...prior,
        lastStartedAt: startedAt,
        lastStatus: status,
        lastError: failureMessage,
        ...(status === 'success' ? { lastCompletedAt: now } : {}),
      };
    }
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* already reclaimed */ }
  }
  writeJson(statePath, nextState);
  return { mode: 'once', jobs, events, lock: lockStatus };
}

export function formatStatus({
  configPath = path.join(ROOT, 'config', 'path.schedule.yml'),
  statePath,
  logPath,
  lockPath,
  now = new Date().toISOString(),
}) {
  const schedule = loadSchedule(configPath);
  const state = readJson(statePath, { jobs: {} });
  const lock = readJson(lockPath, null);
  const lockStatus = evaluateLock(lock, now, schedule.lockTtlMinutes);
  let lastRun = null;
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) lastRun = JSON.parse(lines.at(-1));
  }
  const jobs = {};
  for (const [name, job] of Object.entries(schedule.jobs)) {
    const prior = state.jobs?.[name] || {};
    const lastCompletedAt = prior.lastCompletedAt || null;
    const nextDueAt = lastCompletedAt
      ? new Date(new Date(lastCompletedAt).getTime() + job.everyHours * 60 * 60 * 1000).toISOString()
      : now;
    jobs[name] = {
      ...prior,
      enabled: job.enabled,
      everyHours: job.everyHours,
      mode: job.mode,
      nextDueAt,
      due: new Date(nextDueAt) <= new Date(now),
      lastError: prior.lastError ?? null,
    };
  }
  for (const [name, prior] of Object.entries(state.jobs || {})) {
    if (!jobs[name]) jobs[name] = { ...prior, enabled: false, due: false, lastError: prior.lastError ?? null };
  }
  return { jobs, lock: lockStatus, lastRun };
}

function parseArgs(args) {
  const result = { dryRun: false, once: false, status: false, force: false, jobName: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--once') result.once = true;
    else if (arg === '--status') result.status = true;
    else if (arg === '--force') result.force = true;
    else if (arg === '--job') result.jobName = args[++i];
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = {
    configPath: path.join(ROOT, 'config', 'path.schedule.yml'),
    statePath: path.join(ROOT, 'data', 'path-scheduler-state.json'),
    logPath: path.join(ROOT, 'data', 'path-scheduler-runs.jsonl'),
    lockPath: path.join(ROOT, '.path-runtime', 'path-scheduler.lock'),
  };
  if (options.help) {
    console.log('Usage: node scripts/path-scheduler.mjs [--dry-run|--once|--status] [--job NAME] [--force]');
    return;
  }
  if (options.status) {
    console.log(JSON.stringify(formatStatus(paths), null, 2));
    return;
  }
  const result = await runScheduler({ ...options, ...paths });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Scheduler failed: ${error.message}`); process.exit(1); });
}
