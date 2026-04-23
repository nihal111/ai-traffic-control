// Refresh-call budget + rate-limit cooldown.
//
// The Anthropic token endpoint returns HTTP 429 with a rate_limit_error code
// when we hammer it — this has happened when a refresh-token lineage goes bad
// and multiple processes all try to rotate it within a short window. Once we
// get a 429, we can make things worse by retrying: the limit is on the lineage
// itself, not just on immediate frequency.
//
// This module:
//   - De-duplicates refreshes of the same RT fingerprint within a short window
//   - Records 429 responses as cooldowns, blocking further attempts until expiry
//   - Persists state to disk so the CLI and dashboard server agree on cooldowns
//
// State shape (persisted):
//   {
//     version: 1,
//     lineages: {
//       "<rt_fp>": {
//         lastAttemptAt: iso,
//         lastResult: "ok" | "fatal" | "rate_limited" | "network_error",
//         cooldownUntil: iso | null,
//         attempts: number,
//         lastError: string | null,
//         alias: string | null
//       }
//     }
//   }

import fsSync from 'node:fs';
import path from 'node:path';

function defaultStateFile() {
  return path.join(
    process.env.ATC_DASHBOARD_RUNTIME_DIR ||
      path.join(process.cwd(), 'dashboard', 'runtime'),
    'credential-refresh-budget.json',
  );
}
function stateFile() {
  return process.env.ATC_REFRESH_BUDGET_FILE || defaultStateFile();
}

const DEDUP_WINDOW_MS = Number(process.env.ATC_REFRESH_DEDUP_MS || 60 * 1000); // 60s
const COOLDOWN_MS = Number(process.env.ATC_REFRESH_COOLDOWN_MS || 10 * 60 * 1000); // 10min

function readState() {
  try {
    const raw = fsSync.readFileSync(stateFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { version: 1, lineages: {} };
    if (!parsed.lineages || typeof parsed.lineages !== 'object') parsed.lineages = {};
    return parsed;
  } catch {
    return { version: 1, lineages: {} };
  }
}

function writeState(state) {
  try {
    fsSync.mkdirSync(path.dirname(stateFile()), { recursive: true });
    const tmp = `${stateFile()}.${process.pid}.${Date.now()}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fsSync.renameSync(tmp, stateFile());
  } catch {
    // best-effort — never throw from budget writes
  }
}

// Check whether we should refresh this RT right now. Returns:
//   { allowed: true }                                          — go ahead
//   { allowed: false, reason: 'dedup',     retryAt: ms }       — wait briefly
//   { allowed: false, reason: 'cooldown',  retryAt: ms, error } — lineage rate-limited
function checkBudget(rtFp, { dedupMs = DEDUP_WINDOW_MS, nowMs = Date.now() } = {}) {
  if (!rtFp) return { allowed: true };
  const state = readState();
  const entry = state.lineages[rtFp];
  if (!entry) return { allowed: true };
  const cooldownUntil = entry.cooldownUntil ? Date.parse(entry.cooldownUntil) : NaN;
  if (Number.isFinite(cooldownUntil) && cooldownUntil > nowMs) {
    return {
      allowed: false,
      reason: 'cooldown',
      retryAt: cooldownUntil,
      error: entry.lastError || null,
      alias: entry.alias || null,
    };
  }
  const lastAttempt = entry.lastAttemptAt ? Date.parse(entry.lastAttemptAt) : NaN;
  if (Number.isFinite(lastAttempt) && nowMs - lastAttempt < dedupMs && entry.lastResult === 'ok') {
    return {
      allowed: false,
      reason: 'dedup',
      retryAt: lastAttempt + dedupMs,
      alias: entry.alias || null,
    };
  }
  return { allowed: true };
}

// Record the outcome of a refresh attempt. On 429 we set a cooldown; on 'ok'
// we reset state so the next bad run starts clean.
function recordAttempt(rtFp, { outcome, error = null, alias = null, nowMs = Date.now(), cooldownMs = COOLDOWN_MS } = {}) {
  if (!rtFp) return null;
  const state = readState();
  const prev = state.lineages[rtFp] || { attempts: 0 };
  const next = {
    lastAttemptAt: new Date(nowMs).toISOString(),
    lastResult: outcome,
    attempts: (prev.attempts || 0) + 1,
    lastError: error,
    alias: alias || prev.alias || null,
    cooldownUntil: prev.cooldownUntil || null,
  };
  if (outcome === 'rate_limited') {
    next.cooldownUntil = new Date(nowMs + cooldownMs).toISOString();
  } else if (outcome === 'ok') {
    next.cooldownUntil = null;
    next.lastError = null;
  }
  state.lineages[rtFp] = next;
  writeState(state);
  return next;
}

// Remove a lineage entirely — e.g. after a successful `rotate` that replaces
// the RT with a freshly-issued one. Keeps the budget file small.
function forgetLineage(rtFp) {
  if (!rtFp) return;
  const state = readState();
  if (state.lineages[rtFp]) {
    delete state.lineages[rtFp];
    writeState(state);
  }
}

// Return all active cooldowns as of nowMs, for UI display.
function listCooldowns({ nowMs = Date.now() } = {}) {
  const state = readState();
  const out = [];
  for (const [rtFp, entry] of Object.entries(state.lineages || {})) {
    const until = entry.cooldownUntil ? Date.parse(entry.cooldownUntil) : NaN;
    if (Number.isFinite(until) && until > nowMs) {
      out.push({ rtFp, alias: entry.alias || null, cooldownUntil: entry.cooldownUntil, error: entry.lastError });
    }
  }
  return out;
}

export {
  checkBudget,
  recordAttempt,
  forgetLineage,
  listCooldowns,
  DEDUP_WINDOW_MS,
  COOLDOWN_MS,
};
