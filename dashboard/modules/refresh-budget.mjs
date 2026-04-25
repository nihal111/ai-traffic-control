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
//     version: 2,
//     lineages: {
//       "<rt_fp>": {
//         lastAttemptAt: iso,
//         lastResult: "ok" | "fatal" | "rate_limited" | "network_error",
//         cooldownUntil: iso | null,
//         attempts: number,
//         lastError: string | null,
//         alias: string | null
//       }
//     },
//     aliases: {
//       "<alias>": {
//         attempts: [iso, iso, ...],                      // sliding window
//         rate_limit_lineages: ["<rt_fp>", ...],          // distinct lineages 429'd
//         quarantinedUntil: iso | null,                    // alias-wide block
//         quarantineReason: string | null,
//         quarantineCount: number                          // how many times we've quarantined
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
// Per-alias refresh budget: how many refresh attempts we allow per alias in a
// rolling window. Exceeding this puts the alias into self-quarantine, which
// protects the account from further refresh traffic that would only extend
// Anthropic's lineage cap. The defaults are intentionally conservative:
// legitimate use rarely exceeds 1–2 refreshes per alias per day.
const ALIAS_WINDOW_MS = Number(process.env.ATC_ALIAS_BUDGET_WINDOW_MS || 24 * 60 * 60 * 1000); // 24h
const ALIAS_MAX_ATTEMPTS = Number(process.env.ATC_ALIAS_BUDGET_MAX_ATTEMPTS || 6); // 6/24h
const ALIAS_MAX_429_DISTINCT_LINEAGES = Number(process.env.ATC_ALIAS_MAX_429_LINEAGES || 3); // 3 distinct lineages 429'd = quarantine
const ALIAS_QUARANTINE_MS = Number(process.env.ATC_ALIAS_QUARANTINE_MS || 24 * 60 * 60 * 1000); // 24h

function readState() {
  try {
    const raw = fsSync.readFileSync(stateFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { version: 2, lineages: {}, aliases: {} };
    if (!parsed.lineages || typeof parsed.lineages !== 'object') parsed.lineages = {};
    if (!parsed.aliases || typeof parsed.aliases !== 'object') parsed.aliases = {};
    return parsed;
  } catch {
    return { version: 2, lineages: {}, aliases: {} };
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
//   { allowed: true }                                                  — go ahead
//   { allowed: false, reason: 'dedup',       retryAt: ms }             — wait briefly
//   { allowed: false, reason: 'cooldown',    retryAt: ms, error }      — lineage rate-limited
//   { allowed: false, reason: 'alias-quarantine', retryAt: ms, error } — alias rate-limited at account level
//   { allowed: false, reason: 'alias-budget',     retryAt: ms }        — alias hit self-imposed cap
function checkBudget(rtFp, { dedupMs = DEDUP_WINDOW_MS, nowMs = Date.now(), alias = null } = {}) {
  const state = readState();
  // Check alias-level gates first: even a fresh lineage is forbidden if the
  // alias is quarantined or has hit the per-alias cap. This is what prevents
  // new logins from burning through the account's refresh budget.
  if (alias) {
    const aliasEntry = state.aliases?.[alias];
    if (aliasEntry) {
      const quarantinedUntil = aliasEntry.quarantinedUntil ? Date.parse(aliasEntry.quarantinedUntil) : NaN;
      if (Number.isFinite(quarantinedUntil) && quarantinedUntil > nowMs) {
        return {
          allowed: false,
          reason: 'alias-quarantine',
          retryAt: quarantinedUntil,
          error: aliasEntry.quarantineReason || 'alias quarantined',
          alias,
        };
      }
      const windowStart = nowMs - ALIAS_WINDOW_MS;
      const recent = (aliasEntry.attempts || []).filter((iso) => {
        const t = Date.parse(iso);
        return Number.isFinite(t) && t >= windowStart;
      });
      if (recent.length >= ALIAS_MAX_ATTEMPTS) {
        const oldest = Date.parse(recent[0]);
        return {
          allowed: false,
          reason: 'alias-budget',
          retryAt: oldest + ALIAS_WINDOW_MS,
          error: `alias "${alias}" hit self-imposed cap of ${ALIAS_MAX_ATTEMPTS} refreshes per ${Math.round(ALIAS_WINDOW_MS / 3_600_000)}h`,
          alias,
        };
      }
    }
  }
  if (!rtFp) return { allowed: true };
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

// Check whether an alias is currently quarantined (independent of lineage).
// Used by switch pre-flight to fail fast without touching the refresh endpoint.
function aliasQuarantine(alias, { nowMs = Date.now() } = {}) {
  if (!alias) return null;
  const state = readState();
  const entry = state.aliases?.[alias];
  if (!entry) return null;
  const until = entry.quarantinedUntil ? Date.parse(entry.quarantinedUntil) : NaN;
  if (!Number.isFinite(until) || until <= nowMs) return null;
  return {
    alias,
    quarantinedUntil: entry.quarantinedUntil,
    reason: entry.quarantineReason || null,
    quarantineCount: entry.quarantineCount || 1,
    retryAt: until,
  };
}

// Record the outcome of a refresh attempt. On 429 we set a cooldown; on 'ok'
// we reset state so the next bad run starts clean.
//
// Also updates per-alias tracking:
//   - appends timestamp to alias.attempts (sliding window)
//   - on 429, appends rt_fp to alias.rate_limit_lineages (distinct set)
//     and, if we've now seen ALIAS_MAX_429_DISTINCT_LINEAGES 429s on
//     different lineages within the window, puts the alias in quarantine
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

  // Per-alias tracking: append attempt ts, trim to window, maybe quarantine
  if (alias) {
    if (!state.aliases) state.aliases = {};
    const aliasEntry = state.aliases[alias] || { attempts: [], rate_limit_lineages: [], quarantinedUntil: null, quarantineReason: null, quarantineCount: 0 };
    const windowStart = nowMs - ALIAS_WINDOW_MS;
    // Keep only attempts within the sliding window
    const recentAttempts = (aliasEntry.attempts || []).filter((iso) => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && t >= windowStart;
    });
    recentAttempts.push(new Date(nowMs).toISOString());
    aliasEntry.attempts = recentAttempts;

    if (outcome === 'rate_limited') {
      const lineages = Array.isArray(aliasEntry.rate_limit_lineages) ? aliasEntry.rate_limit_lineages.slice() : [];
      if (!lineages.includes(rtFp)) lineages.push(rtFp);
      aliasEntry.rate_limit_lineages = lineages;
      // Cross-lineage quarantine: 3+ distinct 429'd lineages within window
      // means Anthropic is rate-limiting the ACCOUNT, not just a single bad
      // RT. Quarantine the alias so we stop hammering the account-level cap.
      if (lineages.length >= ALIAS_MAX_429_DISTINCT_LINEAGES
          && (!aliasEntry.quarantinedUntil || Date.parse(aliasEntry.quarantinedUntil) <= nowMs)) {
        aliasEntry.quarantinedUntil = new Date(nowMs + ALIAS_QUARANTINE_MS).toISOString();
        aliasEntry.quarantineReason = `${lineages.length} distinct RT lineages rate-limited within ${Math.round(ALIAS_WINDOW_MS / 3_600_000)}h — account-level cap likely`;
        aliasEntry.quarantineCount = (aliasEntry.quarantineCount || 0) + 1;
      }
    } else if (outcome === 'ok') {
      // A successful refresh proves the account is healthy again — reset
      // the cross-lineage tracker. Quarantine expires naturally.
      aliasEntry.rate_limit_lineages = [];
    }
    state.aliases[alias] = aliasEntry;
  }

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
      out.push({ kind: 'lineage', rtFp, alias: entry.alias || null, cooldownUntil: entry.cooldownUntil, error: entry.lastError });
    }
  }
  for (const [alias, entry] of Object.entries(state.aliases || {})) {
    const until = entry.quarantinedUntil ? Date.parse(entry.quarantinedUntil) : NaN;
    if (Number.isFinite(until) && until > nowMs) {
      out.push({
        kind: 'alias-quarantine',
        alias,
        cooldownUntil: entry.quarantinedUntil,
        error: entry.quarantineReason || null,
        quarantineCount: entry.quarantineCount || 1,
        rateLimitedLineages: Array.isArray(entry.rate_limit_lineages) ? entry.rate_limit_lineages.length : 0,
      });
    }
  }
  return out;
}

// Escape-hatch: force-clear an alias's quarantine (e.g. when user has just
// done a fresh `rotate` and wants to proceed). Does NOT clear lineage-level
// cooldowns — those are per-RT and resolve naturally.
function clearAliasQuarantine(alias) {
  if (!alias) return false;
  const state = readState();
  const entry = state.aliases?.[alias];
  if (!entry || !entry.quarantinedUntil) return false;
  entry.quarantinedUntil = null;
  entry.quarantineReason = null;
  entry.rate_limit_lineages = [];
  writeState(state);
  return true;
}

export {
  checkBudget,
  recordAttempt,
  forgetLineage,
  listCooldowns,
  aliasQuarantine,
  clearAliasQuarantine,
  DEDUP_WINDOW_MS,
  COOLDOWN_MS,
  ALIAS_WINDOW_MS,
  ALIAS_MAX_ATTEMPTS,
  ALIAS_MAX_429_DISTINCT_LINEAGES,
  ALIAS_QUARANTINE_MS,
};
