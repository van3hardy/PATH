export const noModelProvider = Object.freeze({
  async generate() {
    throw codedError('BLOCKED_NO_MODEL_CONFIGURED');
  }
});

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
