import fsSync from 'node:fs';
import path from 'node:path';
import { emptyProfileUsageCache } from './profile-catalog.mjs';

const USAGE_RATE_CACHE_FILE = process.env.USAGE_RATE_CACHE_FILE || path.join(process.cwd(), 'state', 'usage-rate-cache.json');
const CLAUDE_USAGE_MIN_INTERVAL_MS = Number(process.env.ATC_CLAUDE_USAGE_MIN_INTERVAL_MS || 120000);

function buildClaudeRefreshMeta(lastAttemptMs, intervalMs = CLAUDE_USAGE_MIN_INTERVAL_MS) {
  const safeLastAttemptMs = Number.isFinite(lastAttemptMs) ? lastAttemptMs : Date.now();
  const safeIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : CLAUDE_USAGE_MIN_INTERVAL_MS;
  const nextRefreshAtMs = safeLastAttemptMs + safeIntervalMs;
  const remainingMs = Math.max(0, nextRefreshAtMs - Date.now());
  return {
    refreshIntervalMs: safeIntervalMs,
    nextRefreshAt: new Date(nextRefreshAtMs).toISOString(),
    nextRefreshInSec: Math.ceil(remainingMs / 1000),
  };
}

function mergeClaudeUsageWindow(primaryWindow, fallbackWindow) {
  if (!primaryWindow && !fallbackWindow) return null;
  const base = primaryWindow && typeof primaryWindow === 'object' ? primaryWindow : {};
  const fallback = fallbackWindow && typeof fallbackWindow === 'object' ? fallbackWindow : {};
  return {
    ...fallback,
    ...base,
    // Keep CLI-derived consumption as authoritative when available.
    usedPercent: Number.isFinite(Number(base.usedPercent))
      ? Number(base.usedPercent)
      : Number.isFinite(Number(fallback.usedPercent))
        ? Number(fallback.usedPercent)
        : 0,
    // Backfill reset metadata when CLI omits it.
    resetsAt: base.resetsAt || fallback.resetsAt || null,
    resetDescription: base.resetDescription || fallback.resetDescription || null,
    windowMinutes: Number.isFinite(Number(base.windowMinutes))
      ? Number(base.windowMinutes)
      : Number.isFinite(Number(fallback.windowMinutes))
        ? Number(fallback.windowMinutes)
        : null,
  };
}

function defaultProviderRateState() {
  return { lastAttemptAtMs: 0, lastResult: null };
}

function normalizeProviderRateState(entry) {
  if (!entry || typeof entry !== 'object') return defaultProviderRateState();
  const lastAttemptAtMs = Number(entry.lastAttemptAtMs);
  const lastResult = entry.lastResult && typeof entry.lastResult === 'object' ? entry.lastResult : null;
  return {
    lastAttemptAtMs: Number.isFinite(lastAttemptAtMs) && lastAttemptAtMs > 0 ? lastAttemptAtMs : 0,
    lastResult,
  };
}

function readUsageRateCacheFile() {
  try {
    const raw = fsSync.readFileSync(USAGE_RATE_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function loadUsageRateCacheFromDisk() {
  const parsed = readUsageRateCacheFile();
  return {
    codex: normalizeProviderRateState(parsed.codex),
    gemini: normalizeProviderRateState(parsed.gemini),
  };
}

function saveUsageRateCacheToDisk(cacheState) {
  const payload = {
    codex: normalizeProviderRateState(cacheState?.codex),
    gemini: normalizeProviderRateState(cacheState?.gemini),
  };
  try {
    fsSync.mkdirSync(path.dirname(USAGE_RATE_CACHE_FILE), { recursive: true });
    fsSync.writeFileSync(USAGE_RATE_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch {}
}

export {
  buildClaudeRefreshMeta,
  mergeClaudeUsageWindow,
  defaultProviderRateState,
  normalizeProviderRateState,
  readUsageRateCacheFile,
  loadUsageRateCacheFromDisk,
  saveUsageRateCacheToDisk,
  emptyProfileUsageCache,
};
