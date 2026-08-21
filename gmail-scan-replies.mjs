#!/usr/bin/env node
// @ts-check
// gmail-scan-replies.mjs — read-only Inbox scanner feeding reply-watch.mjs (#1583).
//
// Turns recent employer replies in the Gmail Inbox into data/reply-candidates.json
// entries ({ message_id, from, subject, body_snippet, signal: null }) — the exact
// shape reply-watch.mjs consumes. Classification stays in reply-watch.mjs; this
// script never runs it, never imports tracker-*, and never touches
// data/applications.md (preserves the HUMAN_REVIEW guarantee).
//
// Deliberately NO DMARC fail-closed gate (unlike plugins/gmail): legitimate
// employer replies often come from domains that aren't DMARC-aligned, and
// rejecting them would silently starve the pipeline. Blocklist + reply-watch's
// Noise classifier + the human review prompt are the sorting layer instead.
//
// Usage:
//   node gmail-scan-replies.mjs [--days N] [--dry-run]
// Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (same three as
// gmail-send / plugins/gmail). Config (optional): config/plugins.yml →
// plugins.gmail-replies.{days_back, blocklist_senders}.

import { getMessageBody, parseRoleAtCompany } from './plugins/gmail/_helpers.mjs';

/** Inline defaults; config blocklist_senders is additive on top of these. */
const DEFAULT_BLOCKLIST = new Set([
  'alerts.zhaopin.com',
  'job-alerts.linkedin.com',
  'notification.linkedin.com',
  'jobs-list-manager.linkedin.com',
  'notifications@commonapp.org',
]);

/**
 * Build the Gmail list query string.
 * @param {{ days: number }} o
 * @returns {string}
 */
export function buildListQuery({ days }) {
  return `in:inbox newer_than:${days}d`;
}

/**
 * Resolve the blocklist: inline defaults ∪ config overlay. Domains are
 * lowercased; a bare address ("foo@bar.com") is normalized to its domain.
 * @param {{ cfg?: any }} o
 * @returns {Set<string>}
 */
export function resolveBlocklist({ cfg }) {
  const out = new Set(DEFAULT_BLOCKLIST);
  const extra = cfg?.plugins?.['gmail-replies']?.blocklist_senders;
  if (Array.isArray(extra)) {
    for (const raw of extra) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      out.add(normalizeSender(raw));
    }
  }
  return out;
}

/** Normalize an email address or bare domain to a lowercased domain. */
function normalizeSender(value) {
  const v = value.trim().toLowerCase();
  const at = v.lastIndexOf('@');
  return at === -1 ? v : v.slice(at + 1);
}

/**
 * Is the sender (email address or bare domain) on the blocklist?
 * A sender domain matches a blocklist entry if it is equal to the entry
 * or is a subdomain of it (same tail-matching convention as
 * `providers/_trust-validator.mjs:matchesDomainList`, e.g. `mail.alerts.example.com`
 * matches `alerts.example.com`).
 * @param {string} from
 * @param {Set<string>} blocklist
 * @returns {boolean}
 */
export function isBlocklisted(from, blocklist) {
  if (!from) return false;
  const domain = normalizeSender(from);
  for (const entry of blocklist) {
    if (domain === entry || domain.endsWith('.' + entry)) return true;
  }
  return false;
}

/**
 * Extract a reply-watch candidate from a Gmail full-detail payload.
 * @param {{ id: string, threadId?: string, payload: any }} o
 * @returns {{ message_id: string, from: string, subject: string, body_snippet: string, signal: null, thread_id?: string, message_id_header?: string, references?: string, in_reply_to?: string }}
 */
export function parseMessage({ id, threadId, payload }) {
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const pick = (name) => headers.find((h) => h?.name?.toLowerCase() === name)?.value ?? '';
  const from = pick('from');
  const subject = pick('subject');
  const messageIdHeader = pick('message-id');
  const references = pick('references');
  const inReplyTo = pick('in-reply-to');
  const body = getMessageBody(payload);
  const seed = parseRoleAtCompany(subject);
  return {
    message_id: id,
    from,
    subject,
    body_snippet: body || (seed ? `${seed.role} ${seed.company}`.trim() : ''),
    signal: null,
    ...(threadId ? { thread_id: threadId } : {}),
    ...(messageIdHeader ? { message_id_header: messageIdHeader } : {}),
    ...(references ? { references } : {}),
    ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
  };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 * Mirrors transports/gmail-send.mjs and plugins/gmail/index.mjs.
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} creds
 * @param {(url: string, init?: any) => Promise<any>} fetchFn
 * @returns {Promise<string>}
 */
export async function getAccessToken({ clientId, clientSecret, refreshToken }, fetchFn = globalThis.fetch) {
  let response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch (cause) {
    throw codedError('OAUTH_FAILED', cause);
  }
  if (!response.ok) throw codedError('OAUTH_FAILED');
  const data = await response.json().catch(() => ({}));
  if (!data.access_token) throw codedError('OAUTH_FAILED');
  return data.access_token;
}

/**
 * GET the message id list for a query, one page.
 * @param {{ token: string, query: string, pageToken: string | null, fetchFn: any }} o
 * @returns {Promise<{ messages: Array<{ id: string }>, nextPageToken?: string }>}
 */
export async function fetchMessageList({ token, query, pageToken, fetchFn = globalThis.fetch }) {
  let url = `${GMAIL_API}/messages?q=${encodeURIComponent(query)}`;
  if (pageToken) url += `&pageToken=${pageToken}`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw codedError('LIST_FAILED');
  return res.json();
}

/**
 * GET the full detail payload for a single message id.
 * @param {{ token: string, id: string, fetchFn: any }} o
 * @returns {Promise<any>}
 */
export async function fetchMessageDetail({ token, id, fetchFn = globalThis.fetch }) {
  const res = await fetchFn(`${GMAIL_API}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw codedError('DETAIL_FAILED');
  return res.json();
}

/**
 * Extract the set of already-seen Gmail message ids from a candidates array.
 * @param {Array<{ message_id?: string }>} candidates
 * @returns {Set<string>}
 */
export function existingIdsFromCandidates(candidates) {
  return new Set((candidates || []).map((c) => c.message_id).filter(Boolean));
}

/**
 * Scan the Inbox window and hand every new, non-blocklisted message to
 * writeCandidate as a reply-watch candidate. Idempotent: messages already in
 * the candidates file (existingIds) or the shared state cursor are skipped.
 * writeCandidate / writeState are injected so --dry-run can make them no-ops
 * and tests can capture them without touching the file system.
 *
 * @param {object} o
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} o.credentials
 * @param {any} o.cfg
 * @param {number} o.days
 * @param {Set<string>} o.existingIds
 * @param {Set<string>} o.stateCursor
 * @param {any} o.fetchFn
 * @param {(cand: any) => Promise<void>} o.writeCandidate
 * @param {(ids: Set<string>) => Promise<void>} o.writeState
 * @returns {Promise<{ scanned: number, appended: string[], skippedSeen: number, skippedBlocklisted: number, skippedErrored: number }>}
 */
export async function scanReplies({
  credentials, cfg, days, existingIds, stateCursor, fetchFn = globalThis.fetch,
  writeCandidate, writeState,
}) {
  const blocklist = resolveBlocklist({ cfg });
  const token = await getAccessToken(credentials, fetchFn);
  const query = buildListQuery({ days });
  const appended = [];
  let skippedSeen = 0;
  let skippedBlocklisted = 0;
  let skippedErrored = 0;
  let scanned = 0;

  let pageToken = null;
  do {
    const page = await fetchMessageList({ token, query, pageToken, fetchFn });
    for (const entry of page.messages || []) {
      const id = entry.id;
      if (existingIds.has(id) || stateCursor.has(id)) { skippedSeen++; continue; }
      let detail;
      try {
        detail = await fetchMessageDetail({ token, id, fetchFn });
      } catch (err) {
        skippedErrored++;
        console.warn(`gmail-replies: failed to fetch message ${id} — ${err.message}`);
        continue;
      }
      const candidate = parseMessage({ id, threadId: detail?.threadId, payload: detail?.payload });
      if (isBlocklisted(candidate.from, blocklist)) { skippedBlocklisted++; continue; }
      await writeCandidate(candidate);
      appended.push(id);
      scanned++;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  await writeState(new Set([...stateCursor, ...appended]));
  return { scanned, appended, skippedSeen, skippedBlocklisted, skippedErrored };
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES_PATH = process.env.CAREER_OPS_REPLY_CANDIDATES
  || path.join(__dirname, 'data', 'reply-candidates.json');
const STATE_PATH = path.join(__dirname, 'data', 'gmail-state.json');

/**
 * Parse CLI args: [--days N] [--dry-run]. Defaults: days 7, no dry-run.
 * @param {string[]} argv
 * @returns {{ days: number, dryRun: boolean }}
 */
export function parseArgs(argv) {
  const daysIdx = argv.indexOf('--days');
  const days = daysIdx !== -1 && argv[daysIdx + 1]
    ? Number(argv[daysIdx + 1])
    : 7;
  return { days: Number.isInteger(days) && days > 0 ? days : 7, dryRun: argv.includes('--dry-run') };
}

/** Lazy dotenv load; mirrors scripts/path-dispatch.mjs. Optional package. */
let dotenvLoaded = false;
async function loadDotenvOnce() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    const { config } = await import('dotenv');
    config();
  } catch { /* dotenv optional — ambient process.env only */ }
}

function readCandidatesFile() {
  if (!fs.existsSync(CANDIDATES_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readStateFile() {
  if (!fs.existsSync(STATE_PATH)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    return new Set(parsed.processed_message_ids || []);
  } catch {
    return new Set();
  }
}

function saveStateFile(ids) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ processed_message_ids: [...ids] }, null, 2), 'utf-8');
}

function printHelp() {
  console.log(`gmail-scan-replies.mjs — read-only Inbox scanner feeding reply-watch.mjs (#1583)

Usage:
  node gmail-scan-replies.mjs [--days N] [--dry-run]
  node gmail-scan-replies.mjs --help

Scans in:inbox newer_than:Nd, skips blocklisted job-alert senders and messages
already present in data/reply-candidates.json or the shared data/gmail-state.json
cursor, and appends the rest as reply-watch candidates (signal stays null).

--dry-run  lists what would be appended without writing anything.
--days N   look back N days (default 7; config plugins.gmail-replies.days_back overrides).

Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (same three as
gmail-send / plugins/gmail). Next step after scanning: node reply-watch.mjs`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { printHelp(); return; }

  await loadDotenvOnce();
  const { days: cliDays, dryRun } = parseArgs(args);

  const { loadPluginConfig } = await import('./plugins/_engine.mjs');
  const cfg = await loadPluginConfig(__dirname);
  const cfgBlock = cfg?.plugins?.['gmail-replies'] || {};
  const days = Number.isInteger(cfgBlock.days_back) && cfgBlock.days_back > 0 ? cfgBlock.days_back : cliDays;

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    console.error('gmail-replies: missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN in .env');
    process.exit(1);
  }

  const existingIds = existingIdsFromCandidates(readCandidatesFile());
  const stateCursor = readStateFile();

  const { appendCandidate } = await import(pathToFileURL(path.join(__dirname, 'paste-reply.mjs')).href);

  const writeCandidate = dryRun
    ? async () => {}
    : async (cand) => { appendCandidate(cand, CANDIDATES_PATH); };
  const writeState = dryRun
    ? async () => {}
    : saveStateFile;

  const result = await scanReplies({
    credentials: { clientId, clientSecret, refreshToken },
    cfg, days, existingIds, stateCursor,
    writeCandidate, writeState,
  });

  const verb = dryRun ? 'would append' : 'appended';
  console.log(`\n${verb} ${result.appended.length} new reply candidate(s).`);
  console.log(`scanned: ${result.scanned}, skipped already-seen: ${result.skippedSeen}, skipped blocklisted: ${result.skippedBlocklisted}, skipped errored: ${result.skippedErrored}`);
  if (dryRun && result.appended.length > 0) {
    console.log('Dry run — no files were written. Re-run without --dry-run to append.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
