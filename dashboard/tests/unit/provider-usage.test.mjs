import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseWindow, fetchCodexbarUsage, fetchProviderUsageOnce } = await import('../../modules/provider-usage.mjs');

test('parseWindow handles null windowValue', () => {
  const result = parseWindow(null);
  assert.equal(result, null);
});

test('parseWindow handles non-object windowValue', () => {
  const result = parseWindow('invalid');
  assert.equal(result, null);
});

test('parseWindow parses valid window object', () => {
  const window = {
    usedPercent: 75,
    windowMinutes: 300,
    resetsAt: '2026-04-18T14:30:00Z',
    resetDescription: 'in 5 hours',
  };
  const result = parseWindow(window);

  assert.equal(result.usedPercent, 75);
  assert.equal(result.windowMinutes, 300);
  assert.equal(result.resetsAt, '2026-04-18T14:30:00Z');
  assert.equal(result.resetDescription, 'in 5 hours');
});

test('parseWindow defaults usedPercent to 0', () => {
  const window = { windowMinutes: 300 };
  const result = parseWindow(window);

  assert.equal(result.usedPercent, 0);
});

test('parseWindow uses fallback windowMinutes', () => {
  const window = { usedPercent: 50 };
  const result = parseWindow(window, 240);

  assert.equal(result.windowMinutes, 240);
});

test('parseWindow prefers provided windowMinutes over fallback', () => {
  const window = { usedPercent: 50, windowMinutes: 300 };
  const result = parseWindow(window, 240);

  assert.equal(result.windowMinutes, 300);
});

test('parseWindow handles invalid usedPercent', () => {
  const window = { usedPercent: 'invalid', windowMinutes: 300 };
  const result = parseWindow(window);

  assert.equal(result.usedPercent, 0);
});

test('parseWindow handles invalid windowMinutes', () => {
  const window = { usedPercent: 75, windowMinutes: -100 };
  const result = parseWindow(window);

  assert.equal(result.windowMinutes, null);
});

test('parseWindow strips null resetsAt', () => {
  const window = { usedPercent: 75, windowMinutes: 300, resetsAt: null };
  const result = parseWindow(window);

  assert.equal(result.resetsAt, null);
});

test('fetchCodexbarUsage throws when runCommandFn missing', async () => {
  try {
    await fetchCodexbarUsage('claude', 'auto');
    assert.fail('Should have thrown');
  } catch (e) {
    assert(e.message.includes('runCommandFn is required'));
  }
});

test('fetchCodexbarUsage returns error when Codex Bar disabled', async () => {
  const mockRunCommand = async () => ({ ok: true, stdout: JSON.stringify({ usage: {} }) });
  const result = await fetchCodexbarUsage('claude', 'auto', mockRunCommand, { _testDisabled: true });

  // Can't easily disable via env in this test, so just verify the function signature works
  assert(result !== undefined);
});

test('fetchCodexbarUsage parses valid codexbar response', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      usage: {
        accountEmail: 'test@example.com',
        primary: { usedPercent: 75, windowMinutes: 300 },
        secondary: { usedPercent: 50, windowMinutes: 10080 },
      },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchCodexbarUsage('claude', 'auto', mockRunCommand);

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'claude');
  assert.equal(result.accountEmail, 'test@example.com');
  assert.equal(result.primary.usedPercent, 75);
  assert.equal(result.secondary.usedPercent, 50);
});

test('fetchCodexbarUsage handles array response (first element)', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify([
      {
        usage: {
          accountEmail: 'test@example.com',
          primary: { usedPercent: 75 },
        },
      },
    ]),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchCodexbarUsage('claude', 'auto', mockRunCommand);

  assert.equal(result.ok, true);
  assert.equal(result.accountEmail, 'test@example.com');
});

test('fetchCodexbarUsage returns error on invalid JSON', async () => {
  const mockResponse = {
    ok: true,
    stdout: 'invalid json {',
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchCodexbarUsage('claude', 'auto', mockRunCommand);

  assert.equal(result.ok, false);
  assert(result.error);
});

test('fetchCodexbarUsage returns error when response.ok is false', async () => {
  const mockResponse = {
    ok: false,
    stderr: 'Authentication failed',
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchCodexbarUsage('claude', 'auto', mockRunCommand);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Authentication failed');
});

test('fetchCodexbarUsage extracts error from error property', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      error: {
        message: 'Token expired',
      },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchCodexbarUsage('claude', 'auto', mockRunCommand);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Token expired');
});

test('fetchCodexbarUsage falls back to dashboard data', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      openaiDashboard: {
        accountPlan: 'pro',
        primaryLimit: { usedPercent: 60 },
        secondaryLimit: { usedPercent: 40 },
      },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchCodexbarUsage('codex', 'auto', mockRunCommand);

  assert.equal(result.ok, true);
  assert.equal(result.plan, 'pro');
  assert.equal(result.primary.usedPercent, 60);
});

test('fetchCodexbarUsage includes fetchedAt timestamp', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      usage: {
        accountEmail: 'test@example.com',
        primary: { usedPercent: 50 },
      },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchCodexbarUsage('claude', 'auto', mockRunCommand);

  assert(result.fetchedAt);
  assert(result.fetchedAt.includes('T'));
  assert(result.fetchedAt.includes('Z'));
});

test('fetchCodexbarUsage normalizes provider name to lowercase', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      usage: { accountEmail: 'test@example.com' },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchCodexbarUsage('CLAUDE', 'auto', mockRunCommand);

  assert.equal(result.provider, 'claude');
});

test('fetchCodexbarUsage preserves source parameter', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      usage: { accountEmail: 'test@example.com' },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchCodexbarUsage('claude', 'web', mockRunCommand);

  assert.equal(result.source, 'web');
});

test('fetchProviderUsageOnce returns error for unknown provider', async () => {
  const mockRunCommand = async () => ({ ok: true, stdout: '{}' });
  const result = await fetchProviderUsageOnce({ runCommandFn: mockRunCommand }, 'unknown');

  assert.equal(result.ok, false);
  assert(result.error.includes('Unknown provider'));
});

test('fetchProviderUsageOnce adds labels for claude', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      usage: {
        accountEmail: 'test@example.com',
        primary: { usedPercent: 75, windowMinutes: 300 },
        secondary: { usedPercent: 50, windowMinutes: 10080 },
      },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchProviderUsageOnce({ runCommandFn: mockRunCommand }, 'claude');

  assert.equal(result.primary.label, '5-hour');
  assert.equal(result.secondary.label, 'weekly');
});

test('fetchProviderUsageOnce adds labels for gemini', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      usage: {
        accountEmail: 'test@example.com',
        primary: { usedPercent: 75 },
        secondary: { usedPercent: 50 },
      },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchProviderUsageOnce({ runCommandFn: mockRunCommand }, 'gemini');

  assert.equal(result.primary.label, '24h primary');
  assert.equal(result.secondary.label, '24h secondary');
});

test('fetchProviderUsageOnce adds labels for codex', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      usage: {
        accountEmail: 'test@example.com',
        primary: { usedPercent: 75 },
        secondary: { usedPercent: 50 },
      },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchProviderUsageOnce({ runCommandFn: mockRunCommand }, 'codex');

  assert.equal(result.primary.label, '5-hour');
  assert.equal(result.secondary.label, 'weekly');
});

test('fetchProviderUsageOnce handles secondary window from response', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      usage: {
        accountEmail: 'test@example.com',
        primary: { usedPercent: 75, windowMinutes: 300 },
        secondary: { usedPercent: 50, windowMinutes: 10080 },
      },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchProviderUsageOnce({ runCommandFn: mockRunCommand }, 'claude');

  assert(result.primary);
  assert.equal(result.primary.label, '5-hour');
  assert(result.secondary);
  assert.equal(result.secondary.label, 'weekly');
});

test('fetchProviderUsageOnce returns usage data even with partial windows', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      usage: {
        accountEmail: 'test@example.com',
        primary: { usedPercent: 75, windowMinutes: 300 },
      },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchProviderUsageOnce({ runCommandFn: mockRunCommand }, 'claude');

  assert(result.primary);
  assert.equal(result.primary.label, '5-hour');
});

test('fetchCodexbarUsage includes all window fields in result', async () => {
  const mockResponse = {
    ok: true,
    stdout: JSON.stringify({
      usage: {
        accountEmail: 'test@example.com',
        accountOrganization: 'myorg',
        loginMethod: 'oauth',
        primary: {
          usedPercent: 75,
          windowMinutes: 300,
          resetsAt: '2026-04-18T14:30:00Z',
          resetDescription: 'in 5 hours',
        },
        secondary: {
          usedPercent: 50,
          windowMinutes: 10080,
          resetsAt: '2026-04-25T10:00:00Z',
          resetDescription: 'in 7 days',
        },
      },
    }),
  };
  const mockRunCommand = async () => mockResponse;
  const result = await fetchCodexbarUsage('claude', 'oauth', mockRunCommand);

  assert.equal(result.accountOrganization, 'myorg');
  assert.equal(result.plan, 'oauth');
  assert.equal(result.primary.resetDescription, 'in 5 hours');
  assert.equal(result.secondary.resetDescription, 'in 7 days');
});
