import fsSync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { recordEvent, fingerprint } from './credential-events.mjs';

const PROFILES_DIR = path.join(process.env.HOME || '', '.claude-profiles');
const PROFILES_JSON = path.join(PROFILES_DIR, 'profiles.json');
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_GLOBAL_STATE = path.join(process.env.HOME || '', '.claude.json');

function credPath(alias) {
  return path.join(PROFILES_DIR, `${alias}.cred`);
}

function parseCredBlob(blob) {
  try {
    const parsed = JSON.parse(blob);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readKeychainBlob() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const blob = String(stdout || '').trim();
        resolve(blob || null);
      },
    );
  });
}

// Writes blob to <alias>.cred atomically (tmp file + rename). Keeps 0600 perms.
// Silent on failure — callers treat as best-effort.
function writeCredAtomic(alias, blob) {
  const target = credPath(alias);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fsSync.mkdirSync(PROFILES_DIR, { recursive: true });
  fsSync.writeFileSync(tmp, blob, { encoding: 'utf8', mode: 0o600 });
  fsSync.renameSync(tmp, target);
}

// Read a profile's stored credential blob from disk. Null if missing.
function readStoredCred(alias) {
  try {
    return fsSync.readFileSync(credPath(alias), 'utf8').trim();
  } catch {
    return null;
  }
}

// If the live keychain's refresh token differs from what's in <active>.cred,
// snapshot the keychain blob into <active>.cred. This keeps the on-disk copy
// in lockstep with Claude CLI's silent background rotations, so a future
// switch-to doesn't load a single-use-consumed token.
//
// Best-effort: any error (no active profile, keychain empty, filesystem fail)
// is swallowed and reported via the returned object. Callers never await a
// throw — the poll path must not fail because of this sync.
async function syncActiveKeychainToCred({ trigger = 'poll', actor = 'sync-daemon' } = {}) {
  try {
    const catalog = readProfilesJson();
    const alias = typeof catalog.active === 'string' ? catalog.active.trim() : '';
    if (!alias) {
      recordEvent({ actor, action: 'sync-skip', outcome: 'skipped:no-active-profile', trigger });
      return { synced: false, reason: 'no active profile' };
    }
    const expectedEmail =
      typeof catalog.profiles?.[alias]?.email === 'string'
        ? catalog.profiles[alias].email.trim().toLowerCase()
        : '';

    const keychainBlob = await readKeychainBlob();
    if (!keychainBlob) {
      recordEvent({ actor, action: 'sync-skip', alias, outcome: 'skipped:keychain-empty', trigger });
      return { synced: false, reason: 'keychain empty or unreadable' };
    }

    const kcParsed = parseCredBlob(keychainBlob);
    const kcRefresh = String(kcParsed?.claudeAiOauth?.refreshToken || '').trim();
    const kcAccess = String(kcParsed?.claudeAiOauth?.accessToken || '').trim();
    if (!kcRefresh) {
      recordEvent({ actor, action: 'sync-skip', alias, outcome: 'skipped:keychain-no-rt', trigger });
      return { synced: false, reason: 'keychain blob has no refresh token' };
    }

    const storedBlob = readStoredCred(alias);
    const storedParsed = storedBlob ? parseCredBlob(storedBlob) : null;
    const storedRefresh = String(storedParsed?.claudeAiOauth?.refreshToken || '').trim();

    if (storedRefresh && storedRefresh === kcRefresh) {
      try {
        const now = new Date();
        fsSync.utimesSync(credPath(alias), now, now);
      } catch { /* best-effort */ }
      recordEvent({
        actor,
        action: 'sync-check',
        alias,
        alias_email: expectedEmail || null,
        rt_fp: fingerprint(kcRefresh),
        at_fp: fingerprint(kcAccess),
        outcome: 'unchanged',
        trigger,
      });
      return { synced: false, reason: 'already in sync', alias };
    }

    writeCredAtomic(alias, keychainBlob);
    recordEvent({
      actor,
      action: 'sync-write',
      alias,
      alias_email: expectedEmail || null,
      rt_fp: fingerprint(kcRefresh),
      prev_rt_fp: fingerprint(storedRefresh),
      at_fp: fingerprint(kcAccess),
      outcome: 'ok',
      trigger,
    });
    return { synced: true, alias };
  } catch (err) {
    recordEvent({ actor, action: 'sync-error', outcome: `error:${err?.message || err}`, trigger });
    return { synced: false, reason: `error: ${err?.message || err}` };
  }
}

// Staleness metadata for UI display. For the active profile, fresh means the
// dashboard has been syncing successfully. For inactive profiles, fresh means
// the last-saved RT was recent enough that the ~7-day refresh-token lifetime
// has plenty of runway.
function computeProfileStaleness(alias, { now = Date.now(), isActive = false } = {}) {
  let stat = null;
  try { stat = fsSync.statSync(credPath(alias)); } catch { return null; }
  const mtimeMs = stat.mtimeMs;
  const ageMs = Math.max(0, now - mtimeMs);

  const blob = readStoredCred(alias);
  const parsed = blob ? parseCredBlob(blob) : null;
  const expiresRaw = parsed?.claudeAiOauth?.expiresAt;
  const credAccessExpiresAtMs =
    typeof expiresRaw === 'number' && Number.isFinite(expiresRaw)
      ? (expiresRaw < 1e12 ? expiresRaw * 1000 : expiresRaw)
      : null;

  let level;
  if (isActive) {
    // Active profile: stale sync means dashboard can't talk to the keychain.
    if (ageMs > 30 * 60 * 1000) level = 'critical';
    else if (ageMs > 5 * 60 * 1000) level = 'warn';
    else level = 'fresh';
  } else {
    // Inactive profile: stale cred means the saved RT has been sitting unused
    // for long enough that it may age out (Anthropic RT lifetime ~7 days).
    if (ageMs > 6 * 24 * 60 * 60 * 1000) level = 'critical';
    else if (ageMs > 3 * 24 * 60 * 60 * 1000) level = 'warn';
    else level = 'fresh';
  }

  return {
    lastSyncAt: new Date(mtimeMs).toISOString(),
    lastSyncAgeMs: ageMs,
    credAccessExpiresAt: credAccessExpiresAtMs ? new Date(credAccessExpiresAtMs).toISOString() : null,
    credAccessExpired: credAccessExpiresAtMs ? now >= credAccessExpiresAtMs : null,
    stalenessLevel: level,
  };
}

function readProfilesJson() {
  let mutated = false;
  try {
    const text = fsSync.readFileSync(PROFILES_JSON, 'utf8');
    const parsed = JSON.parse(text);
    const catalog = parsed && typeof parsed === 'object' ? parsed : { version: 1, active: null, profiles: {} };
    if (!catalog.version) {
      catalog.version = 1;
      mutated = true;
    }
    if (!catalog.profiles || typeof catalog.profiles !== 'object') {
      catalog.profiles = {};
      mutated = true;
    }
    for (const [alias, meta] of Object.entries(catalog.profiles)) {
      if (!meta || typeof meta !== 'object') {
        catalog.profiles[alias] = {
          displayName: alias,
          usageCache: emptyProfileUsageCache(null),
        };
        mutated = true;
        continue;
      }
      if (!meta.displayName) {
        meta.displayName = alias;
        mutated = true;
      }
      if (!meta.usageCache || typeof meta.usageCache !== 'object') {
        meta.usageCache = emptyProfileUsageCache(meta.email || null);
        mutated = true;
      }
    }
    if (mutated) writeProfilesJson(catalog);
    return catalog;
  } catch {
    return { version: 1, active: null, profiles: {} };
  }
}

function writeProfilesJson(catalog) {
  try {
    fsSync.mkdirSync(PROFILES_DIR, { recursive: true });
    fsSync.writeFileSync(PROFILES_JSON, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  } catch {
    // best effort only
  }
}

function emptyProfileUsageCache(email = null) {
  const safeEmail = typeof email === 'string' && email.trim() ? email.trim() : null;
  return {
    ok: false,
    placeholder: true,
    error: 'n/a',
    fetchedAt: null,
    plan: 'n/a',
    accountEmail: safeEmail,
    primary: null,
    secondary: null,
  };
}

function getActiveProfile() {
  const catalog = readProfilesJson();
  return catalog.active || null;
}

function getActiveProfileEmail() {
  const catalog = readProfilesJson();
  const activeAlias = catalog.active || null;
  if (!activeAlias) return null;
  const email = catalog.profiles?.[activeAlias]?.email;
  return typeof email === 'string' && email.trim() ? email.trim() : null;
}

function getProfileEmailByAlias(alias) {
  const target = String(alias || '').trim();
  if (!target) return null;
  const catalog = readProfilesJson();
  const email = catalog.profiles?.[target]?.email;
  return typeof email === 'string' && email.trim() ? email.trim() : null;
}

// Watch ~/.claude.json for changes and trigger an immediate keychain→cred
// sync. The Claude CLI writes to this file whenever it re-reads the keychain
// (after a refresh or after detecting an external keychain swap), so its
// mtime is our best proxy for "the keychain has probably rotated." Combined
// with a slow safety poll, this gets us near-realtime sync without needing
// native keychain-change notifications.
//
// Returns a stop() function the caller can use to tear down.
function startCredentialWatcher({
  debounceMs = 250,
  safetyPollMs = Number(process.env.ATC_CREDENTIAL_SAFETY_POLL_MS || 10_000),
  actor = 'sync-daemon',
  onSync = null,
} = {}) {
  let watcher = null;
  let debounceTimer = null;
  let safetyTimer = null;
  let stopped = false;

  const fire = async (trigger) => {
    if (stopped) return;
    try {
      const result = await syncActiveKeychainToCred({ trigger, actor });
      if (onSync) onSync(result);
    } catch (err) {
      recordEvent({ actor, action: 'sync-error', outcome: `watcher-error:${err?.message || err}`, trigger });
    }
  };

  const schedule = (trigger) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      fire(trigger);
    }, debounceMs);
  };

  const attachWatcher = () => {
    try {
      watcher = fsSync.watch(CLAUDE_GLOBAL_STATE, { persistent: false }, () => schedule('fs-watch'));
      watcher.on('error', () => {
        try { watcher?.close(); } catch { /* ignore */ }
        watcher = null;
        recordEvent({ actor, action: 'watcher-error', outcome: 'rescheduling', trigger: 'fs-watch' });
        // Retry shortly — file may have been atomically replaced.
        setTimeout(attachWatcher, 1000);
      });
      recordEvent({ actor, action: 'watcher-start', outcome: 'ok', target: CLAUDE_GLOBAL_STATE });
    } catch (err) {
      recordEvent({ actor, action: 'watcher-start', outcome: `error:${err?.message || err}`, target: CLAUDE_GLOBAL_STATE });
      // If the file doesn't exist yet, retry later.
      setTimeout(attachWatcher, 5000);
    }
  };

  attachWatcher();

  // Safety poll — catches rotations that happen without ~/.claude.json changing
  // (should be rare but possible).
  safetyTimer = setInterval(() => schedule('safety-poll'), safetyPollMs);
  if (safetyTimer.unref) safetyTimer.unref();

  // Initial sync at startup so the dashboard doesn't run with a stale snapshot.
  schedule('startup');

  return () => {
    stopped = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (safetyTimer) { clearInterval(safetyTimer); safetyTimer = null; }
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
  };
}

export {
  readProfilesJson,
  writeProfilesJson,
  emptyProfileUsageCache,
  getActiveProfile,
  getActiveProfileEmail,
  getProfileEmailByAlias,
  readKeychainBlob,
  syncActiveKeychainToCred,
  startCredentialWatcher,
  computeProfileStaleness,
  credPath,
  parseCredBlob,
  PROFILES_DIR,
  PROFILES_JSON,
  CLAUDE_GLOBAL_STATE,
};
