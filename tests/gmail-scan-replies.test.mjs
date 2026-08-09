import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildListQuery, resolveBlocklist, isBlocklisted, parseMessage,
} from '../gmail-scan-replies.mjs';

test('buildListQuery renders in:inbox newer_than:Nd', () => {
  assert.equal(buildListQuery({ days: 7 }), 'in:inbox newer_than:7d');
  assert.equal(buildListQuery({ days: 30 }), 'in:inbox newer_than:30d');
});

test('resolveBlocklist unions inline defaults with cfg blocklist_senders', () => {
  const cfg = { plugins: { 'gmail-replies': { blocklist_senders: ['Alerts.Example.com'] } } };
  const set = resolveBlocklist({ cfg });
  assert.ok(set.size >= 1, 'inline defaults present');
  assert.ok(set.has('alerts.example.com'), 'config domain lowercased and merged');
});

test('isBlocklisted matches domain and subdomain-suffixed senders', () => {
  const blocklist = new Set(['alerts.example.com']);
  assert.equal(isBlocklisted('noreply@alerts.example.com', blocklist), true);
  assert.equal(isBlocklisted('noreply@sub.alerts.example.com', blocklist), true);
  assert.equal(isBlocklisted('recruiter@example.com', blocklist), false);
});

test('parseMessage extracts headers + body and sets signal null', () => {
  const payload = {
    headers: [
      { name: 'From', value: 'recruiter@example.com' },
      { name: 'Subject', value: 'Interview invitation' },
    ],
    parts: [{
      body: { data: Buffer.from('Your first-round interview is…').toString('base64url') },
    }],
  };
  const cand = parseMessage({ id: 'abc123', payload });
  assert.deepEqual(cand, {
    message_id: 'abc123',
    from: 'recruiter@example.com',
    subject: 'Interview invitation',
    body_snippet: 'Your first-round interview is…',
    signal: null,
  });
});