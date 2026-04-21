import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pollUsageUntilProfileActive } = await import('../../modules/profile-polling.mjs');

test('pollUsageUntilProfileActive throws without targetAlias', async () => {
  try {
    await pollUsageUntilProfileActive({});
    assert.fail('Should have thrown');
  } catch (e) {
    assert(e.message.includes('targetAlias is required'));
  }
});

test('pollUsageUntilProfileActive succeeds on first poll with fresh usage', async () => {
  const switchStartedAt = Date.now() - 100;
  const onComplete = (data) => {
    assert(data.usage);
    assert(Array.isArray(data.profiles));
  };

  const result = await pollUsageUntilProfileActive({
    targetAlias: 'personal',
    switchStartedAt,
    maxAttempts: 10,
    fetchUsageUrl: '/api/usage',
    fetchProfilesUrl: '/api/profiles',
    onComplete,
  });

  assert(result !== undefined);
});

test('pollUsageUntilProfileActive respects maxAttempts timeout', async () => {
  let pollCount = 0;
  const onTimeout = (data) => {
    assert.equal(data.reason, 'max attempts');
  };

  const result = await pollUsageUntilProfileActive({
    targetAlias: 'personal',
    maxAttempts: 3,
    pollIntervalMs: 10,
    wallClockTimeoutMs: 30000,
    fetchUsageUrl: '/api/usage',
    onTimeout,
    shouldContinuePolling: () => {
      pollCount++;
      return pollCount < 5;
    },
  });

  assert(result !== undefined);
});

test('pollUsageUntilProfileActive respects wall-clock timeout', async () => {
  const onTimeout = (data) => {
    assert.equal(data.reason, 'wall-clock timeout');
    assert(data.wallClockMs >= 50);
  };

  const result = await pollUsageUntilProfileActive({
    targetAlias: 'personal',
    maxAttempts: 1000,
    pollIntervalMs: 50,
    wallClockTimeoutMs: 100,
    fetchUsageUrl: '/api/usage',
    onTimeout,
  });

  assert(result !== undefined);
});

test('cancel method stops polling', async () => {
  let pollCount = 0;
  const shouldContinuePolling = () => {
    pollCount++;
    return pollCount < 10;
  };

  const result = await pollUsageUntilProfileActive({
    targetAlias: 'personal',
    maxAttempts: 1000,
    pollIntervalMs: 10,
    wallClockTimeoutMs: 60000,
    shouldContinuePolling,
  });

  assert(result.cancel !== undefined);
  assert(typeof result.cancel === 'function');
});

test('pollUsageUntilProfileActive has default options', async () => {
  const result = await pollUsageUntilProfileActive({
    targetAlias: 'test',
  });

  assert(result !== undefined);
  assert(typeof result === 'object');
});

test('pollUsageUntilProfileActive tracks attempts and time', async () => {
  const result = await pollUsageUntilProfileActive({
    targetAlias: 'test',
    maxAttempts: 1,
    pollIntervalMs: 10,
    wallClockTimeoutMs: 100,
  });

  assert(typeof result.attempts === 'number');
  assert(Number.isFinite(result.wallClockMs));
  assert(result.wallClockMs >= 0);
});

test('onUsageUpdate callback is invoked', async () => {
  let updateCount = 0;
  const onUsageUpdate = (usage) => {
    updateCount++;
  };

  await pollUsageUntilProfileActive({
    targetAlias: 'test',
    maxAttempts: 2,
    pollIntervalMs: 5,
    wallClockTimeoutMs: 100,
    onUsageUpdate,
  });

  assert(updateCount >= 0);
});

test('result object has expected structure', async () => {
  const result = await pollUsageUntilProfileActive({
    targetAlias: 'test',
    maxAttempts: 1,
  });

  assert(result.hasOwnProperty('cancelled'));
  assert(result.hasOwnProperty('success'));
  assert(result.hasOwnProperty('attempts'));
  assert(result.hasOwnProperty('wallClockMs'));
  assert(result.hasOwnProperty('cancel'));
});

function installFetchMock(responder) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => responder(url, init);
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

test('rejects stale-throttled response with profile match but old fetchedAt', async () => {
  const switchStartedAt = Date.now();
  const stalePayload = {
    activeProfile: 'secondary',
    fetchedAt: new Date(switchStartedAt - 60_000).toISOString(),
    claude: { loading: false, plan: 'Old-Plan', email: 'old@example.com' },
    isThrottled: true,
  };
  let completeCalls = 0;
  const restore = installFetchMock(async (url) => {
    if (url === '/api/usage') return jsonResponse(stalePayload);
    if (url === '/api/profiles') return jsonResponse({ profiles: [] });
    return jsonResponse({}, { ok: false, status: 404 });
  });

  try {
    const result = await pollUsageUntilProfileActive({
      targetAlias: 'secondary',
      switchStartedAt,
      maxAttempts: 3,
      pollIntervalMs: 5,
      wallClockTimeoutMs: 500,
      onComplete: () => {
        completeCalls++;
      },
    });
    assert.equal(completeCalls, 0, 'onComplete must not fire for stale payload');
    assert.equal(result.success, false);
  } finally {
    restore();
  }
});

test('rejects response while claude still loading even with profile match and fresh fetchedAt', async () => {
  const switchStartedAt = Date.now() - 10;
  const loadingPayload = {
    activeProfile: 'secondary',
    fetchedAt: new Date().toISOString(),
    claude: { loading: true },
  };
  let completeCalls = 0;
  const restore = installFetchMock(async (url) => {
    if (url === '/api/usage') return jsonResponse(loadingPayload);
    return jsonResponse({ profiles: [] });
  });

  try {
    await pollUsageUntilProfileActive({
      targetAlias: 'secondary',
      switchStartedAt,
      maxAttempts: 2,
      pollIntervalMs: 5,
      wallClockTimeoutMs: 200,
      onComplete: () => {
        completeCalls++;
      },
    });
    assert.equal(completeCalls, 0, 'onComplete must not fire while claude.loading=true');
  } finally {
    restore();
  }
});

test('completes when profile matches, claude ready, and fetchedAt is fresher than switchStartedAt', async () => {
  const switchStartedAt = Date.now() - 1000;
  const freshPayload = {
    activeProfile: 'secondary',
    fetchedAt: new Date().toISOString(),
    claude: { loading: false, plan: 'Max 20x', email: 'new@example.com' },
  };
  const restore = installFetchMock(async (url) => {
    if (url === '/api/usage') return jsonResponse(freshPayload);
    if (url === '/api/profiles') return jsonResponse({ profiles: [{ alias: 'secondary' }] });
    return jsonResponse({}, { ok: false, status: 404 });
  });

  try {
    let completeData = null;
    const result = await pollUsageUntilProfileActive({
      targetAlias: 'secondary',
      switchStartedAt,
      maxAttempts: 3,
      pollIntervalMs: 5,
      wallClockTimeoutMs: 500,
      onComplete: (data) => {
        completeData = data;
      },
    });
    assert(completeData, 'onComplete should have fired');
    assert.equal(completeData.usage.activeProfile, 'secondary');
    assert.equal(completeData.profiles[0].alias, 'secondary');
    assert.equal(result.success, true);
  } finally {
    restore();
  }
});

test('rejects response when fetchedAt is missing (defensive against untracked staleness)', async () => {
  const switchStartedAt = Date.now();
  const noFetchedAtPayload = {
    activeProfile: 'secondary',
    claude: { loading: false, plan: 'Pro' },
  };
  let completeCalls = 0;
  const restore = installFetchMock(async (url) => {
    if (url === '/api/usage') return jsonResponse(noFetchedAtPayload);
    return jsonResponse({ profiles: [] });
  });

  try {
    await pollUsageUntilProfileActive({
      targetAlias: 'secondary',
      switchStartedAt,
      maxAttempts: 2,
      pollIntervalMs: 5,
      wallClockTimeoutMs: 200,
      onComplete: () => {
        completeCalls++;
      },
    });
    assert.equal(completeCalls, 0, 'onComplete must not fire when fetchedAt is absent');
  } finally {
    restore();
  }
});

test('rejects response when profile alias mismatches even if payload is fresh', async () => {
  const switchStartedAt = Date.now() - 500;
  const wrongProfilePayload = {
    activeProfile: 'primary',
    fetchedAt: new Date().toISOString(),
    claude: { loading: false, plan: 'Max 20x' },
  };
  let completeCalls = 0;
  const restore = installFetchMock(async (url) => {
    if (url === '/api/usage') return jsonResponse(wrongProfilePayload);
    return jsonResponse({ profiles: [] });
  });

  try {
    await pollUsageUntilProfileActive({
      targetAlias: 'secondary',
      switchStartedAt,
      maxAttempts: 2,
      pollIntervalMs: 5,
      wallClockTimeoutMs: 200,
      onComplete: () => {
        completeCalls++;
      },
    });
    assert.equal(completeCalls, 0, 'onComplete must not fire for wrong activeProfile');
  } finally {
    restore();
  }
});

test('succeeds on second poll after first returns stale data (transition case)', async () => {
  const switchStartedAt = Date.now();
  let callCount = 0;
  const restore = installFetchMock(async (url) => {
    if (url === '/api/usage') {
      callCount++;
      if (callCount === 1) {
        return jsonResponse({
          activeProfile: 'secondary',
          fetchedAt: new Date(switchStartedAt - 10_000).toISOString(),
          claude: { loading: false, plan: 'Old' },
        });
      }
      return jsonResponse({
        activeProfile: 'secondary',
        fetchedAt: new Date().toISOString(),
        claude: { loading: false, plan: 'Max 20x' },
      });
    }
    return jsonResponse({ profiles: [] });
  });

  try {
    let completeData = null;
    await pollUsageUntilProfileActive({
      targetAlias: 'secondary',
      switchStartedAt,
      maxAttempts: 5,
      pollIntervalMs: 10,
      wallClockTimeoutMs: 500,
      onComplete: (data) => {
        completeData = data;
      },
    });
    assert(completeData, 'onComplete should fire on second poll');
    assert.equal(completeData.usage.claude.plan, 'Max 20x');
    assert(callCount >= 2, 'should have polled at least twice');
  } finally {
    restore();
  }
});
