import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRemoteSource, verifyFacts, verifyFactsWithRemote } from '../../verify-cv-facts.mjs';

function fakeFetch(body, { status = 200 } = {}) {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

test('fetchRemoteSource returns body text on HTTP 200', async () => {
  const text = await fetchRemoteSource('https://example.test/cv', { fetchFn: fakeFetch('hello evidence') });
  assert.equal(text, 'hello evidence');
});

test('fetchRemoteSource throws a coded error on HTTP failure', async () => {
  await assert.rejects(
    () => fetchRemoteSource('https://example.test/missing', { fetchFn: fakeFetch('nope', { status: 404 }) }),
    /remote source failed: https:\/\/example\.test\/missing \(HTTP 404\)/,
  );
});

test('fetchRemoteSource wraps network-level failures as unreachable', async () => {
  await assert.rejects(
    () => fetchRemoteSource('https://example.test/down', { fetchFn: async () => { throw new Error('ECONNREFUSED'); } }),
    /remote source unreachable: https:\/\/example\.test\/down \(ECONNREFUSED\)/,
  );
});

test('verifyFactsWithRemote accepts a metric backed by a remote source', async () => {
  const fetchFn = fakeFetch('Reached 94,772 active users across 80 courses.');
  const result = await verifyFactsWithRemote('Reached 94,772 users', {
    sourcePaths: [],
    remoteSources: [{ url: 'https://example.test/digest' }],
    fetchFn,
  });
  assert.deepEqual(result.invented, []);
});

test('verifyFactsWithRemote still blocks the same metric without the remote source', async () => {
  const result = await verifyFactsWithRemote('Reached 94,772 users', {
    sourcePaths: [],
    remoteSources: [],
    fetchFn: fakeFetch('irrelevant'),
  });
  assert.deepEqual(result.invented, ['94772 users']);
});

test('verifyFacts stays synchronous and network-free by default', () => {
  const result = verifyFacts('Reached 94,772 users', { sourcePaths: [] });
  assert.ok(!(result instanceof Promise));
  assert.deepEqual(result.invented, ['94772 users']);
});
