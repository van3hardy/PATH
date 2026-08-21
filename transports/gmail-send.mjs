// @ts-check
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function buildMessage({ to, subject, body, inReplyTo, references }) {
  const headers = [
    `To: ${to.name} <${to.address}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8'
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  return [
    ...headers,
    '',
    body
  ].join('\r\n');
}

async function exchangeAccessToken({ clientId, clientSecret, refreshToken }, fetchFn) {
  let response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });
  } catch (error) {
    throw codedError('SEND_FAILED_OAUTH', error);
  }
  if (!response.ok) throw codedError('SEND_FAILED_OAUTH');
  const data = await response.json().catch(() => ({}));
  if (!data.access_token) throw codedError('SEND_FAILED_OAUTH');
  return data.access_token;
}

export async function sendGmailMessage({
  clientId,
  clientSecret,
  refreshToken,
  to,
  subject,
  body,
  threadId,
  inReplyTo,
  references,
  fetchFn = globalThis.fetch
}) {
  const accessToken = await exchangeAccessToken({ clientId, clientSecret, refreshToken }, fetchFn);
  const raw = Buffer.from(buildMessage({ to, subject, body, inReplyTo, references }), 'utf8').toString('base64url');
  const payload = threadId ? { raw, threadId } : { raw };

  let response;
  try {
    response = await fetchFn(SEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    throw codedError('SEND_FAILED_HTTP', error);
  }
  if (!response.ok) {
    await response.text().catch(() => {});
    throw codedError('SEND_FAILED_API');
  }
  const data = await response.json().catch(() => ({}));
  if (!data.id) throw codedError('SEND_FAILED_API');
  return { ok: true, messageId: data.id };
}
