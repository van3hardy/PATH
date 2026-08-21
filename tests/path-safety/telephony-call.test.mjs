import assert from 'node:assert/strict';
import test from 'node:test';
import { placeCall } from '../../transports/telephony-call.mjs';

const RELAY_URL = 'https://relay.example.test/calls';

const DEFAULT_ARGS = {
  relayUrl: RELAY_URL,
  to: { name: 'Hiring Manager', phone: '+15551234567' },
  script: 'Hi, this is Van following up on the AI Engineer role.'
};

test('happy path posts JSON payload to the relay and returns its messageId', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ messageId: 'call-123' }) };
  };

  const result = await placeCall({ ...DEFAULT_ARGS, fetchFn });
  assert.deepEqual(result, { ok: true, messageId: 'call-123' });

  const [call] = calls;
  assert.equal(call.url, RELAY_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  const payload = JSON.parse(call.init.body);
  assert.deepEqual(payload.to, { name: 'Hiring Manager', phone: '+15551234567' });
  assert.equal(payload.script, 'Hi, this is Van following up on the AI Engineer role.');
});

test('api key is sent as a bearer header when provided', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ messageId: 'call-key' }) };
  };

  const result = await placeCall({ ...DEFAULT_ARGS, apiKey: 'secret-key', fetchFn });
  assert.deepEqual(result, { ok: true, messageId: 'call-key' });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-key');
});

test('no authorization header is sent without an api key', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ messageId: 'call-noauth' }) };
  };

  await placeCall({ ...DEFAULT_ARGS, fetchFn });
  assert.equal('Authorization' in calls[0].init.headers, false);
});

test('missing relay URL fails closed with SEND_FAILED_CONFIG before any network call', async () => {
  let networkCalled = false;
  const fetchFn = async () => {
    networkCalled = true;
  };
  await assert.rejects(
    placeCall({ ...DEFAULT_ARGS, relayUrl: undefined, fetchFn }),
    (err) => err.message === 'SEND_FAILED_CONFIG'
  );
  assert.equal(networkCalled, false);
});

for (const status of [400, 401, 403, 429, 500]) {
  test(`relay ${status} maps to SEND_FAILED_API`, async () => {
    const fetchFn = async () => ({ ok: false, status, json: async () => ({}), text: async () => 'nope' });
    await assert.rejects(
      placeCall({ ...DEFAULT_ARGS, fetchFn }),
      (err) => err.message === 'SEND_FAILED_API'
    );
  });
}

test('relay success without a messageId maps to SEND_FAILED_API', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(
    placeCall({ ...DEFAULT_ARGS, fetchFn }),
    (err) => err.message === 'SEND_FAILED_API'
  );
});

test('relay fetch rejection maps to SEND_FAILED_HTTP', async () => {
  const fetchFn = async () => {
    throw new TypeError('ENOTFOUND relay.example.test');
  };
  await assert.rejects(
    placeCall({ ...DEFAULT_ARGS, fetchFn }),
    (err) => err.message === 'SEND_FAILED_HTTP'
  );
});
