import { PROVIDER_IDS } from './provider-ids.mjs';

export { PROVIDER_IDS, REAL_PROVIDER_IDS } from './provider-ids.mjs';

export async function getProvider(id, options = {}) {
  if (!PROVIDER_IDS.includes(id)) {
    throw codedError('BLOCKED_UNSUPPORTED_PROVIDER');
  }
  if (id === 'fake') {
    const module = await import('./fake-provider.mjs');
    return module.fakeProvider;
  }
  if (id === 'none') {
    const module = await import('./no-model-provider.mjs');
    return module.noModelProvider;
  }
  if (id === 'openai') {
    const module = await import('./openai-provider.mjs');
    return module.createOpenAIProvider(options);
  }
  const module = await import('./gemini-provider.mjs');
  return module.createGeminiProvider(options);
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}