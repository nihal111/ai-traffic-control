import fsSync from 'node:fs';
import path from 'node:path';

const PROFILES_DIR = path.join(process.env.HOME || '', '.claude-profiles');
const PROFILES_JSON = path.join(PROFILES_DIR, 'profiles.json');

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
  PROFILES_DIR,
  PROFILES_JSON,
};
