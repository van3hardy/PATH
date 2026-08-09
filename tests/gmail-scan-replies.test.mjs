import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildListQuery, resolveBlocklist, isBlocklisted, parseMessage,
  getAccessToken, fetchMessageList, fetchMessageDetail,
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

test('getAccessToken exchanges the refresh grant and returns the access token', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok-9' }) };
  };
  const token = await getAccessToken(
    { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok' }, fetchFn
  );
  assert.equal(token, 'tok-9');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(calls[0].init.body.toString(), /client_id=cid/);
  assert.match(calls[0].init.body.toString(), /refresh_token=rtok/);
  assert.match(calls[0].init.body.toString(), /grant_type=refresh_token/);
});

test('getAccessToken rejects on token-refresh failure', async () => {
  const fetchFn = async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => 'bad' });
  await assert.rejects(
    getAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, fetchFn),
    (err) => err.message === 'OAUTH_FAILED'
  );
});

test('fetchMessageList passes query + pageToken and returns nextPageToken', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return {
      ok: true, status: 200,
      json: async () => ({ messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'pg2' }),
    };
  };
  const out = await fetchMessageList({ token: 't', query: 'in:inbox newer_than:7d', pageToken: null, fetchFn });
  assert.deepEqual(out.messages, [{ id: 'm1' }, { id: 'm2' }]);
  assert.equal(out.nextPageToken, 'pg2');
  assert.ok(calls[0].includes('q=in%3Ainbox%20newer_than%3A7d'));
  assert.ok(calls[0].includes('pageToken=pg2') === false);
  assert.ok(calls[0].startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages'));
});

test('fetchMessageDetail GETs the full message payload', async () => {
  const fetchFn = async (url) => {
    assert.ok(url.includes('/messages/m1?format=full'));
    return { ok: true, status: 200, json: async () => ({ id: 'm1', payload: {} }) };
  };
  const detail = await fetchMessageDetail({ token: 't', id: 'm1', fetchFn });
  assert.equal(detail.id, 'm1');
});