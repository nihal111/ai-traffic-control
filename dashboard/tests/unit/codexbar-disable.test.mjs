import assert from 'node:assert/strict';
import { test } from 'node:test';

// Set test import to avoid server startup
process.env.DASHBOARD_TEST_IMPORT = '1';
process.env.ATC_DISABLE_CODEX_BAR = '1';

const { fetchCodexbarUsage } = await import('../../server.mjs');

test('fetchCodexbarUsage returns error when disabled via environment variable', async () => {
  const result = await fetchCodexbarUsage('codex');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'Codex Bar disabled');
});
