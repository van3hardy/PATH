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
 * @param {{ id: string, payload: any }} o
 * @returns {{ message_id: string, from: string, subject: string, body_snippet: string, signal: null }}
 */
export function parseMessage({ id, payload }) {
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const pick = (name) => headers.find((h) => h?.name?.toLowerCase() === name)?.value ?? '';
  const from = pick('from');
  const subject = pick('subject');
  const body = getMessageBody(payload);
  const seed = parseRoleAtCompany(subject);
  return {
    message_id: id,
    from,
    subject,
    body_snippet: body || (seed ? `${seed.role} ${seed.company}`.trim() : ''),
    signal: null,
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