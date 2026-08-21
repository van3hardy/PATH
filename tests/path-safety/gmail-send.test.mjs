import assert from 'node:assert/strict';
import test from 'node:test';
import { sendGmailMessage } from '../../transports/gmail-send.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

const DEFAULT_ARGS = {
  clientId: 'cid',
  clientSecret: 'csec',
  refreshToken: 'rtok',
  to: { name: 'Hiring Manager', address: 'hm@example.com' },
  subject: 'AI Engineer @ Example Company',
  body: 'Agent workflows on Windows 11.'
};

function tokenResponse() {
  return { ok: true, status: 200, json: async () => ({ access_token: 'tok-1' }) };
}

test('happy path posts raw message to messages/send and returns messageId', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url === TOKEN_URL) return tokenResponse();
    return { ok: true, status: 200, json: async () => ({ id: 'msg-abc' }) };
  };

  const result = await sendGmailMessage({ ...DEFAULT_ARGS, fetchFn });
  assert.deepEqual(result, { ok: true, messageId: 'msg-abc' });

  const [tokenCall, sendCall] = calls;
  assert.equal(tokenCall.url, TOKEN_URL);
  assert.match(tokenCall.init.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  assert.match(tokenCall.init.body.toString(), /client_id=cid/);
  assert.match(tokenCall.init.body.toString(), /refresh_token=rtok/);
  assert.match(tokenCall.init.body.toString(), /grant_type=refresh_token/);
  assert.equal(tokenCall.init.method, 'POST');

  assert.equal(sendCall.url, SEND_URL);
  assert.equal(sendCall.init.method, 'POST');
  assert.equal(sendCall.init.headers.Authorization, 'Bearer tok-1');
  assert.match(sendCall.init.headers['Content-Type'], /application\/json/);

  const raw = JSON.parse(sendCall.init.body).raw;
  const message = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(message, /^To: Hiring Manager <hm@example\.com>\r?\n/i);
  assert.match(message, /^Subject: AI Engineer @ Example Company\r?\n/im);
  assert.match(message, /^MIME-Version: 1\.0\r?\n/im);
  assert.match(message, /^Content-Type: text\/plain/im);
  assert.ok(message.endsWith('Agent workflows on Windows 11.'), message);
});

test('reply sends include thread id and reply headers without changing first-touch sends', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url === TOKEN_URL) return tokenResponse();
    return { ok: true, status: 200, json: async () => ({ id: 'msg-reply' }) };
  };

  const result = await sendGmailMessage({
    ...DEFAULT_ARGS,
    subject: 'Re: AI Engineer @ Example Company',
    threadId: 'thread-123',
    inReplyTo: '<original@example.com>',
    references: '<root@example.com> <original@example.com>',
    fetchFn
  });
  assert.deepEqual(result, { ok: true, messageId: 'msg-reply' });

  const [, sendCall] = calls;
  const payload = JSON.parse(sendCall.init.body);
  assert.equal(payload.threadId, 'thread-123');
  const message = Buffer.from(payload.raw, 'base64url').toString('utf8');
  assert.match(message, /^In-Reply-To: <original@example\.com>\r?\n/im);
  assert.match(message, /^References: <root@example\.com> <original@example\.com>\r?\n/im);
});

test('token refresh rejection maps to SEND_FAILED_OAUTH and does not hit the send endpoint', async () => {
  let sendCalled = false;
  const fetchFn = async (url) => {
    if (url === SEND_URL) sendCalled = true;
    return { ok: false, status: 400, json: async () => ({}), text: async () => 'bad grant' };
  };
  await assert.rejects(
    sendGmailMessage({ ...DEFAULT_ARGS, fetchFn }),
    (err) => err.message === 'SEND_FAILED_OAUTH'
  );
  assert.equal(sendCalled, false);
});

for (const status of [400, 403, 429, 500]) {
  test(`API ${status} maps to SEND_FAILED_API`, async () => {
    const fetchFn = async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      return { ok: false, status, json: async () => ({}), text: async () => 'nope' };
    };
    await assert.rejects(
      sendGmailMessage({ ...DEFAULT_ARGS, fetchFn }),
      (err) => err.message === 'SEND_FAILED_API'
    );
  });
}

test('send-endpoint fetch rejection maps to SEND_FAILED_HTTP', async () => {
  const fetchFn = async (url) => {
    if (url === TOKEN_URL) return tokenResponse();
    throw new TypeError('ENOTFOUND example.com');
  };
  await assert.rejects(
    sendGmailMessage({ ...DEFAULT_ARGS, fetchFn }),
    (err) => err.message === 'SEND_FAILED_HTTP'
  );
});

test('token-endpoint fetch rejection maps to SEND_FAILED_OAUTH', async () => {
  const fetchFn = async () => {
    throw new TypeError('ECONNREFUSED');
  };
  await assert.rejects(
    sendGmailMessage({ ...DEFAULT_ARGS, fetchFn }),
    (err) => err.message === 'SEND_FAILED_OAUTH'
  );
});
