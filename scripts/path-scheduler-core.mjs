import path from 'node:path';

const ALLOWED_SCRIPTS = new Set([
  'scan.mjs',
  'followup-cadence.mjs',
  'gmail-scan-replies.mjs',
  'reply-watch.mjs',
]);

function invalid(message) {
  throw new Error(`Invalid schedule: ${message}`);
}

function positiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) invalid(`${label} must be positive`);
  return value;
}

function normalizeCommand(command, label) {
  if (!Array.isArray(command) || command.length < 2 || command.some(part => typeof part !== 'string' || part.length === 0)) {
    invalid(`${label}.command must be a non-empty string array`);
  }
  return [...command];
}

export function validateSchedule(input) {
  if (!input || typeof input !== 'object' || input.version !== 'path-schedule-v1') invalid('version must be path-schedule-v1');
  if (typeof input.timezone !== 'string' || !input.timezone.trim()) invalid('timezone is required');
  positiveNumber(Number(input.lockTtlMinutes), 'lockTtlMinutes');
  if (!input.jobs || typeof input.jobs !== 'object' || Array.isArray(input.jobs)) invalid('jobs are required');

  const jobs = {};
  for (const [name, raw] of Object.entries(input.jobs)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(`${name} must be an object`);
    const everyHours = Number(raw.everyHours);
    positiveNumber(everyHours, `${name}.everyHours`);
    if (!['local_write_only', 'review_only'].includes(raw.mode)) invalid(`${name}.mode is unsupported`);
    const command = normalizeCommand(raw.command, name);
    if (raw.after !== undefined && !Array.isArray(raw.after)) invalid(`${name}.after must be an array`);
    const after = raw.after === undefined ? [] : raw.after.map((cmd, i) => normalizeCommand(cmd, `${name}.after[${i}]`));
    jobs[name] = { enabled: raw.enabled !== false, everyHours, command, after, mode: raw.mode };
  }
  return { version: input.version, timezone: input.timezone, lockTtlMinutes: Number(input.lockTtlMinutes), jobs };
}

function iso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date;
}

export function getDueJobs(schedule, state = {}, now = new Date().toISOString(), options = {}) {
  const current = iso(now);
  const selected = options.jobName || null;
  const force = options.force === true;
  const jobState = state?.jobs || {};
  const result = [];
  for (const [name, job] of Object.entries(schedule.jobs)) {
    if (selected && name !== selected) continue;
    if (!job.enabled) continue;
    const last = jobState[name]?.lastCompletedAt;
    const nextDue = last ? new Date(iso(last).getTime() + job.everyHours * 60 * 60 * 1000) : current;
    if (!force && nextDue > current) continue;
    result.push({ name, ...job, nextDueAt: nextDue.toISOString(), reasonCode: force ? 'FORCED' : 'DUE' });
  }
  if (selected && result.length === 0 && !schedule.jobs[selected]) invalid(`unknown job ${selected}`);
  return result;
}

export function evaluateLock(lock, now = new Date().toISOString(), ttlMinutes = 60) {
  if (!lock) return { state: 'AVAILABLE', reasonCode: 'LOCK_AVAILABLE' };
  const acquired = iso(lock.acquiredAt);
  const expiresAt = new Date(acquired.getTime() + Number(ttlMinutes) * 60 * 1000).toISOString();
  if (iso(now) < new Date(expiresAt)) {
    return { state: 'LOCKED', reasonCode: 'LOCK_ACTIVE', runId: lock.runId, expiresAt };
  }
  return { state: 'STALE_RECLAIMABLE', reasonCode: 'LOCK_STALE', runId: lock.runId, expiresAt };
}

export function classifyCommand(command) {
  const values = Array.isArray(command) ? command : [];
  const joined = values.join(' ').toLowerCase();
  const script = values[1] ? path.basename(values[1]) : values[0] || '';
  if (joined.includes('path-dispatch') && values.some(value => value === '--send')) return { allowed: false, reasonCode: 'BLOCKED_SEND_FLAG', script };
  if (script === 'gmail-send.mjs' || joined.includes('transports/gmail-send')) return { allowed: false, reasonCode: 'BLOCKED_DIRECT_GMAIL_SEND', script };
  if (script === 'browser.submit' || joined.includes('submit_application') || joined.includes('browser.submit')) return { allowed: false, reasonCode: 'BLOCKED_CONSEQUENTIAL_ACTION', script };
  if (script === 'reply-watch.mjs' && !(values.includes('--no-apply') && values.includes('--json'))) return { allowed: false, reasonCode: 'BLOCKED_INTERACTIVE_COMMAND', script };
  if (script === 'scan.mjs' && values.includes('--headed-fallback')) return { allowed: false, reasonCode: 'BLOCKED_HEADED_BROWSER', script };
  if (!ALLOWED_SCRIPTS.has(script)) return { allowed: false, reasonCode: 'BLOCKED_UNKNOWN_COMMAND', script };
  return { allowed: true, reasonCode: 'ALLOW_REVIEW_ONLY', script };
}

export function buildEvent({ runId, jobName, status, reasonCode, command, startedAt, finishedAt }) {
  return { runId, job: jobName, status, reasonCode, command: [...command], startedAt, finishedAt };
}
