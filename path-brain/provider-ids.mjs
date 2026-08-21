export const PROVIDER_IDS = Object.freeze(['fake', 'none', 'gemini', 'openai']);
export const REAL_PROVIDER_IDS = Object.freeze(['gemini', 'openai']);
export const DEFAULT_MODEL = 'gemini-3.6-flash';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

export function isRealProvider(id) {
  return REAL_PROVIDER_IDS.includes(id);
}