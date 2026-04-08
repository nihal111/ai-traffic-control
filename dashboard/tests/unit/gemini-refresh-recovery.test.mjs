import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DASHBOARD_TEST_IMPORT = '1';
const { fetchCodexbarUsage } = await import('../../server.mjs');

test('gemini usage retries after OAuth extraction failure and recovers', async () => {
  const calls = [];
  const runCommandMock = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'codexbar' && calls.length === 1) {
      return {
        ok: true,
        stdout: JSON.stringify([
          {
            provider: 'gemini',
            source: 'auto',
            error: { code: 1, kind: 'provider', message: 'Gemini API error: Could not find Gemini CLI OAuth configuration' },
          },
        ]),
        stderr: '',
      };
    }
    if (cmd === 'gemini') return { ok: true, stdout: '{"response":"ok"}', stderr: '' };
    if (cmd === 'codexbar' && calls.length === 3) {
      return {
        ok: true,
        stdout: JSON.stringify([
          {
            provider: 'gemini',
            source: 'api',
            usage: {
              loginMethod: 'Paid',
              updatedAt: '2026-04-08T01:38:35Z',
              primary: { usedPercent: 1, windowMinutes: 1440, resetsAt: '2026-04-09T01:38:35Z' },
              secondary: { usedPercent: 2, windowMinutes: 1440, resetsAt: '2026-04-09T00:29:50Z' },
            },
          },
        ]),
        stderr: '',
      };
    }
    throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
  };

  const result = await fetchCodexbarUsage('gemini', 'auto', runCommandMock);

  assert.equal(result.ok, true);
  assert.equal(result.recoveredViaGeminiRefresh, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].cmd, 'gemini');
  assert.deepEqual(calls[1].args, ['-p', 'ok', '--output-format', 'json']);
});

test('non-gemini provider does not trigger gemini refresh recovery', async () => {
  const calls = [];
  const runCommandMock = async (cmd, args) => {
    calls.push({ cmd, args });
    return { ok: false, stdout: '', stderr: 'codexbar usage failed' };
  };

  const result = await fetchCodexbarUsage('claude', 'web', runCommandMock);

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'codexbar');
});
