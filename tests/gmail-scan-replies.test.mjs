import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildListQuery, resolveBlocklist, isBlocklisted, parseMessage,
  getAccessToken, fetchMessageList, fetchMessageDetail,
  existingIdsFromCandidates, scanReplies,
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

test('scanReplies appends only unseen, non-blocklisted messages', async () => {
  const detailPayloads = {
    m1: { id: 'm1', payload: { headers: [{ name: 'From', value: 'r1@example.com' }, { name: 'Subject', value: 'Interview' }], parts: [{ body: { data: Buffer.from('hi').toString('base64url') } }] } },
    m2: { id: 'm2', payload: { headers: [{ name: 'From', value: 'noreply@alerts.example.com' }, { name: 'Subject', value: 'Job alert' }], parts: [] } },
  };
  const fetchFn = async (url) => {
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 't' }) };
    if (url.includes('/messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }) };
    const id = /\/messages\/([^?]+)\?format=full/.exec(url)?.[1];
    if (id === 'm3') return { ok: true, json: async () => ({ id: 'm3', payload: { headers: [{ name: 'From', value: 'seen@example.com' }], parts: [] } }) };
    return { ok: true, json: async () => detailPayloads[id] };
  };
  const writes = [];
  const result = await scanReplies({
    credentials: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
    cfg: { plugins: { 'gmail-replies': { blocklist_senders: ['alerts.example.com'] } } },
    days: 7,
    existingIds: new Set(['m3']),   // m3 already a candidate → skipped
    stateCursor: new Set(),
    fetchFn,
    writeCandidate: async (cand) => { writes.push(cand); },
    writeState: async () => {},
  });
  assert.deepEqual(result.appended, ['m1']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].message_id, 'm1');
  assert.equal(result.skippedSeen, 1);       // m3
  assert.equal(result.skippedBlocklisted, 1); // m2
  assert.equal(result.skippedErrored, 0);
});

test('scanReplies survives a single bad detail fetch', async () => {
  const fetchFn = async (url) => {
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 't' }) };
    if (url.includes('/messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'bad' }] }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const writes = [];
  const result = await scanReplies({
    credentials: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
    cfg: {}, days: 7, existingIds: new Set(), stateCursor: new Set(),
    fetchFn,
    writeCandidate: async (cand) => writes.push(cand),
    writeState: async () => {},
  });
  assert.equal(result.skippedErrored, 1);
  assert.equal(writes.length, 0);
});

test('existingIdsFromCandidates extracts message_ids from candidate arrays', () => {
  const ids = existingIdsFromCandidates([
    { message_id: 'a' }, { message_id: 'b' },
  ]);
  assert.deepEqual([...ids].sort(), ['a', 'b']);
});
