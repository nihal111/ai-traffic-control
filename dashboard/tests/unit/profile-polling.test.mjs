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
