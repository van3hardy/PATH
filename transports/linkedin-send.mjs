// @ts-check

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

export async function sendLinkedInMessage({
  relayUrl,
  apiKey,
  to,
  subject,
  body,
  fetchFn = globalThis.fetch
}) {
  if (!relayUrl || typeof relayUrl !== 'string') throw codedError('SEND_FAILED_CONFIG');

  let response;
  try {
    response = await fetchFn(relayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({ to, subject, body })
    });
  } catch (error) {
    throw codedError('SEND_FAILED_HTTP', error);
  }
  if (!response.ok) {
    await response.text().catch(() => {});
    throw codedError('SEND_FAILED_API');
  }
  const data = await response.json().catch(() => ({}));
  if (!data.messageId) throw codedError('SEND_FAILED_API');
  return { ok: true, messageId: data.messageId };
}
