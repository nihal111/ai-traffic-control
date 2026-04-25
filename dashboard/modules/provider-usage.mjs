import { execFile } from 'node:child_process';
import { buildClaudeRefreshMeta, mergeClaudeUsageWindow } from './usage-cache.mjs';
import { readProfilesJson, emptyProfileUsageCache, syncActiveKeychainToCred } from './profile-catalog.mjs';

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_USAGE_TIMEOUT_MS = Number(process.env.ATC_CLAUDE_OAUTH_USAGE_TIMEOUT_MS || 8000);

function readClaudeKeychainAccessToken() {
  if (process.platform !== 'darwin') return null;
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const parsed = JSON.parse(String(stdout || '').trim());
          const token = parsed?.claudeAiOauth?.accessToken;
          resolve(typeof token === 'string' && token.trim() ? token.trim() : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function parseAnthropicUsageWindow(windowValue, fallbackMinutes) {
  if (!windowValue || typeof windowValue !== 'object') return null;
  const usedPercent = Number(windowValue.utilization);
  if (!Number.isFinite(usedPercent)) return null;
  return {
    usedPercent,
    windowMinutes: fallbackMinutes,
    resetsAt: typeof windowValue.resets_at === 'string' && windowValue.resets_at.trim() ? windowValue.resets_at : null,
    resetDescription: null,
  };
}

async function fetchClaudeUsageFromAnthropicApi() {
  const token = await readClaudeKeychainAccessToken();
  if (!token) return { ok: false, error: 'No Claude OAuth token in keychain', provider: 'claude' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_OAUTH_USAGE_TIMEOUT_MS);
  try {
    const response = await fetch(CLAUDE_OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Match upstream claude-code's axios fingerprint. Anthropic's edge
        // 429s non-axios UAs against OAuth endpoints regardless of token
        // validity (verified 2026-04-25 root-causing recurring profile-switch
        // failures). The previous 'atc-dashboard' UA was the wrong shape.
        Accept: 'application/json, text/plain, */*',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'axios/1.7.7',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `Anthropic usage API HTTP ${response.status}`, provider: 'claude' };
    }
    const data = await response.json();
    return {
      ok: true,
      provider: 'claude',
      source: 'anthropic-api',
      plan: null,
      accountEmail: null,
      primary: parseAnthropicUsageWindow(data?.five_hour, 300),
      secondary: parseAnthropicUsageWindow(data?.seven_day, 10080),
      updatedAt: null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, error: `Anthropic usage API error: ${err?.message || err}`, provider: 'claude' };
  } finally {
    clearTimeout(timer);
  }
}

// Constants (passed via environment or defaults)
const DISABLE_CODEX_BAR = process.argv.includes('--no-codexbar') || process.env.ATC_DISABLE_CODEX_BAR === '1';
const PROVIDERS = new Set(['codex', 'claude', 'gemini']);
const CLAUDE_USAGE_MIN_INTERVAL_MS = Number(process.env.ATC_CLAUDE_USAGE_MIN_INTERVAL_MS || 120000);
const CODEX_USAGE_MIN_INTERVAL_MS = Number(process.env.ATC_CODEX_USAGE_MIN_INTERVAL_MS || 30000);
const GEMINI_USAGE_MIN_INTERVAL_MS = Number(process.env.ATC_GEMINI_USAGE_MIN_INTERVAL_MS || 30000);
const USAGE_TTL_MS = 10000;

function parseWindow(windowValue, fallbackMinutes = null) {
  if (typeof windowValue === 'number' || typeof windowValue === 'string') {
    const usedPercent = Number(windowValue);
    if (!Number.isFinite(usedPercent)) return null;
    return {
      usedPercent,
      windowMinutes: fallbackMinutes,
      resetsAt: null,
      resetDescription: null,
    };
  }
  if (!windowValue || typeof windowValue !== 'object') return null;
  const usedPercent = Number(windowValue.usedPercent ?? 0);
  const windowMinutes = Number(windowValue.windowMinutes ?? fallbackMinutes ?? 0);
  return {
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : 0,
    windowMinutes: Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : fallbackMinutes,
    resetsAt: windowValue.resetsAt || null,
    resetDescription: windowValue.resetDescription || null,
  };
}

function pickFirstObject(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

function resolveUsageWindow(root, usage, dashboard, key) {
  const aliasesByKey = {
    primary: [
      'primary',
      'primaryLimit',
      'fiveHour',
      'fiveHourLimit',
      'fiveHourWindow',
      'window5h',
      'rolling5h',
    ],
    secondary: [
      'secondary',
      'secondaryLimit',
      'weekly',
      'weeklyLimit',
      'weeklyWindow',
      'sevenDay',
      'sevenDayLimit',
      'rolling7d',
    ],
  };
  const aliases = aliasesByKey[key] || [key];
  const usageWindows = pickFirstObject(usage?.windows, usage?.limits);
  const dashboardWindows = pickFirstObject(dashboard?.windows, dashboard?.limits);
  for (const alias of aliases) {
    const candidate = pickFirstObject(
      usage?.[alias],
      usageWindows?.[alias],
      dashboard?.[alias],
      dashboardWindows?.[alias],
      root?.[alias],
      root?.usage?.[alias],
      root?.openaiDashboard?.[alias],
    );
    if (candidate) return candidate;

    const scalar = usage?.[alias] ?? usageWindows?.[alias] ?? dashboard?.[alias] ?? dashboardWindows?.[alias];
    if (typeof scalar === 'number' || typeof scalar === 'string') return scalar;
  }
  return null;
}

function hasUsageWindowData(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const windows = [payload.primary, payload.secondary];
  return windows.some((windowValue) => {
    if (!windowValue || typeof windowValue !== 'object') return false;
    return (
      Number.isFinite(Number(windowValue.usedPercent)) ||
      Number.isFinite(Number(windowValue.windowMinutes)) ||
      !!windowValue.resetsAt ||
      !!windowValue.resetDescription
    );
  });
}

function backfillResetFromCache(liveWindow, cachedWindow, nowMs = Date.now()) {
  if (!liveWindow || typeof liveWindow !== 'object') return liveWindow;
  if (liveWindow.resetsAt) return liveWindow;
  if (!cachedWindow || typeof cachedWindow !== 'object') return liveWindow;
  const cachedReset = cachedWindow.resetsAt ? Date.parse(cachedWindow.resetsAt) : NaN;
  // Only backfill when the cached reset is still in the future: rolling 5h
  // windows restart on first message, so a past resetsAt means the window
  // has already rolled and we no longer know when the new one ends.
  if (!Number.isFinite(cachedReset) || cachedReset <= nowMs) return liveWindow;
  return {
    ...liveWindow,
    resetsAt: cachedWindow.resetsAt,
    resetDescription: liveWindow.resetDescription || cachedWindow.resetDescription || null,
  };
}

async function fetchCodexbarUsage(provider, source = 'auto', runCommandFn = null, options = {}) {
  if (!runCommandFn) throw new Error('runCommandFn is required');
  if (DISABLE_CODEX_BAR) {
    return { ok: false, error: 'Codex Bar disabled', provider };
  }

  const parseResult = (raw) => {
    let parsed = null;
    if (raw?.stdout && String(raw.stdout).trim()) {
      try {
        parsed = JSON.parse(raw.stdout);
      } catch {
        parsed = null;
      }
    }

    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    if (root && typeof root === 'object') {
      if (root.error) return { ok: false, error: root.error.message || 'provider error', provider };

      const usage = pickFirstObject(root.usage, root.result?.usage) || null;
      const dashboard = pickFirstObject(root.openaiDashboard, root.result?.openaiDashboard) || null;
      const primary = resolveUsageWindow(root, usage, dashboard, 'primary');
      const secondary = resolveUsageWindow(root, usage, dashboard, 'secondary');
      return {
        ok: true,
        provider: (provider || '').toLowerCase(),
        source: root.source || source || 'auto',
        plan: usage?.loginMethod || dashboard?.accountPlan || null,
        accountEmail: usage?.accountEmail || null,
        accountOrganization: usage?.accountOrganization || null,
        primary: parseWindow(primary),
        secondary: parseWindow(secondary),
        updatedAt: usage?.updatedAt || null,
        fetchedAt: new Date().toISOString(),
      };
    }

    if (!raw?.ok) return { ok: false, error: raw?.stderr || 'codexbar usage failed', provider };
    return { ok: false, error: 'codexbar returned empty payload', provider };
  };

  const shouldAttemptGeminiRefresh = (errorMessage) => {
    if (String(provider || '').toLowerCase() !== 'gemini') return false;
    const msg = String(errorMessage || '').toLowerCase();
    return (
      msg.includes('could not extract oauth credentials from gemini cli') ||
      msg.includes('could not find gemini cli oauth configuration')
    );
  };

  const providerKey = String(provider || '').toLowerCase();
  const accountLabel = typeof options?.account === 'string' && options.account.trim() ? options.account.trim() : null;
  const callCodexbar = async (selectedSource, timeoutMs) => {
    const args = ['usage', '--provider', provider, '--format', 'json'];
    if (selectedSource) args.push('--source', selectedSource);
    if (accountLabel && providerKey === 'claude') args.push('--account', accountLabel);
    return runCommandFn('codexbar', args, timeoutMs);
  };

  const commandTimeoutMs =
    providerKey === 'claude'
      ? Number(process.env.ATC_CLAUDE_CODEXBAR_TIMEOUT_MS || 25000)
      : 12000;
  let raw = await callCodexbar(source, commandTimeoutMs);
  let result = parseResult(raw);

  if (shouldAttemptGeminiRefresh(result.error)) {
    const refresh = await runCommandFn('gemini', ['-p', 'ok', '--output-format', 'json'], 25000);
    if (refresh.ok) {
      const retriedRaw = await callCodexbar(source, commandTimeoutMs);
      result = parseResult(retriedRaw);
      if (result.ok) return { ...result, recoveredViaGeminiRefresh: true };
    }
  }

  return result;
}

async function fetchClaudeUsageRateLimited(context = {}, { force = false } = {}) {
  const { runCommandFn = null, providerUsageRateCache = {} } = context;
  const catalog = readProfilesJson();
  const activeAlias = String(catalog.active || '').trim();
  const activeMeta = activeAlias && catalog.profiles ? catalog.profiles[activeAlias] : null;
  const profileEmail = typeof activeMeta?.email === 'string' && activeMeta.email.trim() ? activeMeta.email.trim() : null;
  const profileSubscriptionType =
    typeof activeMeta?.authState?.authStatus?.subscriptionType === 'string' && activeMeta.authState.authStatus.subscriptionType.trim()
      ? activeMeta.authState.authStatus.subscriptionType.trim()
      : null;
  const cachedUsage =
    activeMeta?.usageCache && typeof activeMeta.usageCache === 'object'
      ? { ...activeMeta.usageCache }
      : emptyProfileUsageCache(profileEmail);
  const lastAttemptIso = cachedUsage.lastAttemptAt || cachedUsage.fetchedAt || null;
  const lastAttemptMs = lastAttemptIso ? Date.parse(lastAttemptIso) : NaN;
  const hasRecentAttempt =
    !force && Number.isFinite(lastAttemptMs) && Date.now() - lastAttemptMs < CLAUDE_USAGE_MIN_INTERVAL_MS;
  const lastAttemptAtIso = Number.isFinite(lastAttemptMs) ? new Date(lastAttemptMs).toISOString() : null;

  if (hasRecentAttempt) {
    return {
      ...cachedUsage,
      provider: 'claude',
      source: cachedUsage.source || 'oauth-cache',
      loading: false,
      throttled: true,
      ...(lastAttemptAtIso ? { lastAttemptAt: lastAttemptAtIso } : {}),
      ...buildClaudeRefreshMeta(lastAttemptMs),
    };
  }

  const attemptedAtMs = Date.now();
  const attemptedAtIso = new Date(attemptedAtMs).toISOString();
  let live = await fetchCodexbarUsage('claude', 'oauth', runCommandFn);
  if (!live?.ok) {
    const webFallback = await fetchCodexbarUsage('claude', 'web', runCommandFn);
    if (webFallback?.ok) {
      live = webFallback;
    } else {
      const cliFallback = await fetchCodexbarUsage('claude', 'cli', runCommandFn);
      if (cliFallback?.ok && (!cliFallback?.primary?.resetsAt || !cliFallback?.secondary?.resetsAt)) {
        const webForResets = await fetchCodexbarUsage('claude', 'web', runCommandFn);
        if (webForResets?.ok) {
          live = {
            ...cliFallback,
            primary: mergeClaudeUsageWindow(cliFallback.primary, webForResets.primary),
            secondary: mergeClaudeUsageWindow(cliFallback.secondary, webForResets.secondary),
            tertiary: mergeClaudeUsageWindow(cliFallback.tertiary, webForResets.tertiary),
          };
        } else {
          live = cliFallback;
        }
      } else {
        live = cliFallback;
      }
    }
  }
  // Backfill resetsAt from Anthropic's OAuth usage endpoint (read via the Claude
  // CLI keychain token) when codexbar's available sources don't expose it —
  // typically the CLI-only path, since the claude CLI reports usedPercent but
  // never a rolling reset time for the 5-hour window.
  if (live?.ok && (!live?.primary?.resetsAt || !live?.secondary?.resetsAt)) {
    const apiUsage = await fetchClaudeUsageFromAnthropicApi();
    if (apiUsage?.ok) {
      live = {
        ...live,
        primary: mergeClaudeUsageWindow(live.primary, apiUsage.primary),
        secondary: mergeClaudeUsageWindow(live.secondary, apiUsage.secondary),
      };
    }
  }
  let resolvedLive =
    live?.ok && !String(live.plan || '').trim() && profileSubscriptionType
      ? { ...live, plan: profileSubscriptionType }
      : live;
  if (resolvedLive?.ok) {
    resolvedLive = {
      ...resolvedLive,
      primary: backfillResetFromCache(resolvedLive.primary, cachedUsage?.primary, attemptedAtMs),
      secondary: backfillResetFromCache(resolvedLive.secondary, cachedUsage?.secondary, attemptedAtMs),
    };
  }
  if (!resolvedLive?.ok && hasUsageWindowData(cachedUsage)) {
    return {
      ...cachedUsage,
      ok: true,
      provider: 'claude',
      loading: false,
      source: cachedUsage.source || resolvedLive?.source || 'oauth-cache',
      stale: true,
      staleError: resolvedLive?.error || 'Usage temporarily unavailable',
      lastAttemptAt: attemptedAtIso,
      ...buildClaudeRefreshMeta(attemptedAtMs),
    };
  }
  // A successful poll confirms the active keychain credential is still live.
  // Snapshot it to the active profile's .cred so silent background RT rotations
  // don't strand us with a consumed single-use token at next switch.
  if (resolvedLive?.ok) {
    await syncActiveKeychainToCred({ trigger: 'usage-poll', actor: 'sync-daemon' });
  }
  return {
    ...resolvedLive,
    throttled: false,
    lastAttemptAt: attemptedAtIso,
    ...buildClaudeRefreshMeta(attemptedAtMs),
  };
}

async function fetchProviderUsageRateLimited(context = {}, provider, source, intervalMs) {
  const { runCommandFn = null, providerUsageRateCache = {} } = context;
  const providerKey = String(provider || '').toLowerCase();
  const state = providerUsageRateCache[providerKey];
  const safeIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 120000;
  const nowMs = Date.now();
  const hasRecentAttempt =
    !!state &&
    Number.isFinite(state.lastAttemptAtMs) &&
    state.lastAttemptAtMs > 0 &&
    nowMs - state.lastAttemptAtMs < safeIntervalMs;

  if (hasRecentAttempt) {
    const fallbackResult =
      state.lastResult && typeof state.lastResult === 'object'
        ? state.lastResult
        : {
            ok: false,
            provider: providerKey,
            loading: false,
            error: 'Rate limited: waiting for next refresh window',
            source: `${source || 'auto'}-cache`,
          };
    return {
      ...fallbackResult,
      loading: false,
      throttled: true,
      source: fallbackResult?.source || `${source || 'auto'}-cache`,
      ...buildClaudeRefreshMeta(state.lastAttemptAtMs, safeIntervalMs),
    };
  }

  const attemptedAtMs = Date.now();
  const live = await fetchCodexbarUsage(providerKey, source, runCommandFn);

  if (!state) {
    return { ...live, throttled: false, ...buildClaudeRefreshMeta(attemptedAtMs, safeIntervalMs) };
  }

  let merged;
  if (live?.ok || !state.lastResult) {
    merged = {
      ...live,
      throttled: false,
      ...buildClaudeRefreshMeta(attemptedAtMs, safeIntervalMs),
    };
  } else {
    const hasCachedWindows = hasUsageWindowData(state.lastResult);
    const keepLastKnown = state.lastResult?.ok && hasCachedWindows;
    merged = {
      ...state.lastResult,
      ok: keepLastKnown ? true : false,
      loading: false,
      provider: providerKey,
      ...(keepLastKnown
        ? {
            stale: true,
            staleError: live?.error || state.lastResult?.error || 'Usage unavailable',
          }
        : {
            error: live?.error || state.lastResult?.error || 'Usage unavailable',
          }),
      source: live?.source || state.lastResult?.source || source || 'auto',
      throttled: false,
      ...buildClaudeRefreshMeta(attemptedAtMs, safeIntervalMs),
    };
  }

  return merged;
}

async function fetchProviderUsageOnce(context = {}, providerKey, { force = false } = {}) {
  const { runCommandFn = null, providerUsageRateCache = {} } = context;
  const normalized = String(providerKey || '').toLowerCase();
  if (!PROVIDERS.has(normalized)) {
    return { ok: false, provider: normalized, loading: false, error: 'Unknown provider' };
  }

  const intervalMs =
    normalized === 'claude'
      ? CLAUDE_USAGE_MIN_INTERVAL_MS
      : normalized === 'gemini'
        ? GEMINI_USAGE_MIN_INTERVAL_MS
        : CODEX_USAGE_MIN_INTERVAL_MS;

  if (normalized === 'claude') {
    const result = await fetchClaudeUsageRateLimited({ runCommandFn, providerUsageRateCache }, { force });
    return {
      ...result,
      primary: result.primary ? { ...result.primary, label: '5-hour' } : null,
      secondary: result.secondary ? { ...result.secondary, label: 'weekly' } : null,
    };
  }
  if (normalized === 'gemini') {
    const result = await fetchProviderUsageRateLimited(
      { runCommandFn, providerUsageRateCache },
      'gemini',
      'auto',
      intervalMs,
    );
    return {
      ...result,
      primary: result.primary ? { ...result.primary, label: '24h primary' } : null,
      secondary: result.secondary ? { ...result.secondary, label: '24h secondary' } : null,
    };
  }
  const result = await fetchProviderUsageRateLimited(
    { runCommandFn, providerUsageRateCache },
    'codex',
    'cli',
    intervalMs,
  );
  return {
    ...result,
    primary: result.primary ? { ...result.primary, label: '5-hour' } : null,
    secondary: result.secondary ? { ...result.secondary, label: 'weekly' } : null,
  };
}

export {
  parseWindow,
  backfillResetFromCache,
  parseAnthropicUsageWindow,
  fetchClaudeUsageFromAnthropicApi,
  fetchCodexbarUsage,
  fetchClaudeUsageRateLimited,
  fetchProviderUsageRateLimited,
  fetchProviderUsageOnce,
};
