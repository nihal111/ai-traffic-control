import fsSync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const PROFILES_DIR = path.join(process.env.HOME || '', '.claude-profiles');
const PROFILES_JSON = path.join(PROFILES_DIR, 'profiles.json');
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

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
async function syncActiveKeychainToCred() {
  try {
    const catalog = readProfilesJson();
    const alias = typeof catalog.active === 'string' ? catalog.active.trim() : '';
    if (!alias) return { synced: false, reason: 'no active profile' };

    const keychainBlob = await readKeychainBlob();
    if (!keychainBlob) return { synced: false, reason: 'keychain empty or unreadable' };

    const kcParsed = parseCredBlob(keychainBlob);
    const kcRefresh = String(kcParsed?.claudeAiOauth?.refreshToken || '').trim();
    if (!kcRefresh) return { synced: false, reason: 'keychain blob has no refresh token' };

    const storedBlob = readStoredCred(alias);
    if (storedBlob) {
      const storedParsed = parseCredBlob(storedBlob);
      const storedRefresh = String(storedParsed?.claudeAiOauth?.refreshToken || '').trim();
      if (storedRefresh && storedRefresh === kcRefresh) {
        // Touch mtime so "last successful sync check" stays fresh for the UI
        // even when RT hasn't rotated. Without this, an active profile whose
        // RT rotates rarely would look stale despite the dashboard polling it.
        try {
          const now = new Date();
          fsSync.utimesSync(credPath(alias), now, now);
        } catch {
          // best-effort — missing file or perms issue is non-fatal
        }
        return { synced: false, reason: 'already in sync', alias };
      }
    }

    writeCredAtomic(alias, keychainBlob);
    return { synced: true, alias };
  } catch (err) {
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

export {
  readProfilesJson,
  writeProfilesJson,
  emptyProfileUsageCache,
  getActiveProfile,
  getActiveProfileEmail,
  getProfileEmailByAlias,
  readKeychainBlob,
  syncActiveKeychainToCred,
  computeProfileStaleness,
  credPath,
  parseCredBlob,
  PROFILES_DIR,
  PROFILES_JSON,
};
