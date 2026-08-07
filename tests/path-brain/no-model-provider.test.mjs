import assert from 'node:assert/strict';
import test from 'node:test';

import { noModelProvider } from '../../path-brain/no-model-provider.mjs';

test('noModelProvider always blocks because no model is configured', async () => {
  await assert.rejects(
    noModelProvider.generate({ arbitrary: 'input' }),
    (error) => error.code === 'BLOCKED_NO_MODEL_CONFIGURED'
  );
});
