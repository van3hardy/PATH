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