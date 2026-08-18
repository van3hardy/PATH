export const PROVIDER_IDS = Object.freeze(['fake', 'none', 'gemini']);
export const REAL_PROVIDER_IDS = Object.freeze(['gemini']);
export const DEFAULT_MODEL = 'gemini-3.6-flash';

export function isRealProvider(id) {
  return REAL_PROVIDER_IDS.includes(id);
}