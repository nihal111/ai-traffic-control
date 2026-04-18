// Profile switching polling with timeouts and cancellation

async function pollUsageUntilProfileActive(options = {}) {
  const {
    targetAlias = null,
    switchStartedAt = Date.now(),
    maxAttempts = 80,
    pollIntervalMs = 200,
    wallClockTimeoutMs = 16000,
    fetchUsageUrl = '/api/usage',
    fetchProfilesUrl = '/api/profiles',
    onUsageUpdate = null,
    onComplete = null,
    onTimeout = null,
    shouldContinuePolling = null,
  } = options;

  if (!targetAlias) {
    throw new Error('targetAlias is required');
  }

  let attempts = 0;
  let cancelled = false;
  const startTime = Date.now();

  const cancel = () => {
    cancelled = true;
  };

  const checkWallClockTimeout = () => {
    const elapsed = Date.now() - startTime;
    return elapsed >= wallClockTimeoutMs;
  };

  const checkAttemptTimeout = () => {
    return attempts >= maxAttempts;
  };

  const pollOnce = async () => {
    if (cancelled) return false;
    if (checkWallClockTimeout()) {
      if (onTimeout) onTimeout({ attempts, reason: 'wall-clock timeout', wallClockMs: Date.now() - startTime });
      return false;
    }
    if (checkAttemptTimeout()) {
      if (onTimeout) onTimeout({ attempts, reason: 'max attempts', wallClockMs: Date.now() - startTime });
      return false;
    }

    if (shouldContinuePolling && !shouldContinuePolling()) {
      cancel();
      return false;
    }

    try {
      const resp = await fetch(fetchUsageUrl);
      if (!resp.ok) {
        attempts++;
        return true;
      }

      const usage = await resp.json();
      if (!usage || typeof usage !== 'object') {
        attempts++;
        return true;
      }

      if (onUsageUpdate) onUsageUpdate(usage);

      const isFresh = usage.fetchedAt ? Date.parse(usage.fetchedAt) > switchStartedAt : false;
      const isThrottled = !!usage.claude?.throttled;
      const profileMatches = usage.activeProfile === targetAlias;
      const claudeReady = usage.claude && !usage.claude.loading;

      if (profileMatches && claudeReady && (isFresh || isThrottled)) {
        if (onComplete) {
          try {
            const profileResp = await fetch(fetchProfilesUrl, { cache: 'no-store' });
            if (profileResp.ok) {
              const profilePayload = await profileResp.json();
              onComplete({ usage, profiles: profilePayload?.profiles || [] });
            } else {
              onComplete({ usage, profiles: [] });
            }
          } catch {
            onComplete({ usage, profiles: [] });
          }
        }
        return false;
      }

      attempts++;
      return true;
    } catch (error) {
      attempts++;
      return true;
    }
  };

  const poll = async () => {
    let continuePolling = await pollOnce();
    while (continuePolling && !cancelled) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continuePolling = await pollOnce();
    }
  };

  const result = await Promise.race([
    poll(),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), wallClockTimeoutMs + 1000)),
  ]);

  return {
    cancelled,
    success: !cancelled && attempts < maxAttempts && !checkWallClockTimeout(),
    attempts,
    wallClockMs: Date.now() - startTime,
    cancel,
  };
}

export { pollUsageUntilProfileActive };
