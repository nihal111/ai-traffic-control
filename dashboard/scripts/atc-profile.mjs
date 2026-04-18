#!/usr/bin/env node
/**
 * atc-profile — manage multiple Claude Pro/Max account profiles
 *
 * On macOS, Claude Code stores OAuth credentials in Keychain under the service
 * name "Claude Code-credentials". Switching profiles swaps that Keychain entry.
 * The ~/.claude directory is shared across profiles (settings, hooks, projects).
 *
 * Commands:
 *   add <alias>   — save the currently-logged-in Keychain entry as a profile
 *   list          — show all registered profiles (active marked with *)
 *   use  <alias>  — switch to a profile (swaps Keychain entry)
 *   current       — print the active profile alias
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const PROFILES_DIR = path.join(os.homedir(), '.claude-profiles');
const PROFILES_JSON = path.join(PROFILES_DIR, 'profiles.json');
const BACKUP_DIR = path.join(PROFILES_DIR, '.backup');
const CODEXBAR_CONFIG = path.join(os.homedir(), '.codexbar', 'config.json');
const CLAUDE_GLOBAL_STATE = path.join(os.homedir(), '.claude.json');
const CLAUDE_OAUTH_ACCOUNT_URL = 'https://api.anthropic.com/api/oauth/account';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadCatalog() {
  const catalog = readJson(PROFILES_JSON, { version: 1, active: null, profiles: {} });
  if (!catalog || typeof catalog !== 'object') return { version: 1, active: null, profiles: {} };
  if (!catalog.version) catalog.version = 1;
  if (!catalog.profiles || typeof catalog.profiles !== 'object') catalog.profiles = {};
  for (const [alias, meta] of Object.entries(catalog.profiles)) {
    if (!meta || typeof meta !== 'object') {
      catalog.profiles[alias] = { displayName: alias, usageCache: placeholderUsageCache(null) };
      continue;
    }
    if (!meta.displayName) meta.displayName = alias;
    if (!meta.usageCache || typeof meta.usageCache !== 'object') {
      meta.usageCache = placeholderUsageCache(meta.email || null);
    }
  }
  return catalog;
}

function saveCatalog(catalog) {
  writeJsonAtomic(PROFILES_JSON, catalog);
}

function readClaudeGlobalState() {
  return readJson(CLAUDE_GLOBAL_STATE, {});
}

function writeClaudeGlobalState(state) {
  writeJsonAtomic(CLAUDE_GLOBAL_STATE, state);
}

function profileCookieLabel(alias) {
  return `atc:${alias}`;
}

function placeholderUsageCache(email) {
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

function parseCredentialBlob(blob) {
  try {
    const parsed = JSON.parse(blob);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function chooseClaudeMembership(memberships) {
  if (!Array.isArray(memberships) || memberships.length === 0) return null;
  return memberships.find((membership) => {
    const org = membership?.organization;
    return org?.billing_type === 'stripe_subscription'
      || org?.billing_type === 'team_subscription'
      || (Array.isArray(org?.capabilities) && org.capabilities.includes('claude_pro'));
  }) || memberships[0];
}

function fetchClaudeAccountStateFromBlob(blob) {
  const parsed = parseCredentialBlob(blob);
  const accessToken = parsed?.claudeAiOauth?.accessToken?.trim();
  if (!accessToken) {
    throw new Error('saved credential is missing Claude OAuth accessToken');
  }

  let raw;
  try {
    raw = execFileSync('curl', [
      '-sS',
      '--max-time', String(Number(process.env.ATC_CLAUDE_ACCOUNT_TIMEOUT_SEC || 8)),
      '-H', `Authorization: Bearer ${accessToken}`,
      '-H', 'anthropic-beta: oauth-2025-04-20',
      CLAUDE_OAUTH_ACCOUNT_URL,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 2 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const detail = typeof error?.stderr === 'string' && error.stderr.trim()
      ? error.stderr.trim()
      : error.message || 'unknown oauth account failure';
    throw new Error(`could not fetch Claude account metadata: ${detail}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Claude account metadata was not valid JSON');
  }

  const membership = chooseClaudeMembership(payload?.memberships);
  const organization = membership?.organization || {};
  const email = typeof payload?.email_address === 'string' ? payload.email_address.trim().toLowerCase() : null;
  const orgId = typeof organization?.uuid === 'string' ? organization.uuid : null;
  const orgName = typeof organization?.name === 'string' ? organization.name : null;
  const subscriptionType = parsed?.claudeAiOauth?.subscriptionType || null;

  return {
    capturedAt: new Date().toISOString(),
    source: 'api/oauth/account',
    authStatus: {
      email,
      orgId,
      orgName,
      subscriptionType,
    },
    oauthAccount: {
      accountUuid: typeof payload?.uuid === 'string' ? payload.uuid : null,
      emailAddress: email,
      organizationUuid: orgId,
      hasExtraUsageEnabled: null,
      billingType: organization?.billing_type ?? null,
      accountCreatedAt: payload?.created_at ?? null,
      subscriptionCreatedAt: membership?.created_at ?? null,
      displayName: payload?.display_name ?? payload?.full_name ?? null,
      organizationRole: membership?.role ?? null,
      workspaceRole: membership?.seat_tier ?? null,
      organizationName: orgName,
    },
  };
}

function ensureProfileAuthState(catalog, alias, blob = null) {
  const profile = catalog?.profiles?.[alias];
  if (!profile) {
    throw new Error(`Unknown profile "${alias}".`);
  }
  if (profile.authState && typeof profile.authState === 'object') {
    return profile.authState;
  }
  const authState = fetchClaudeAccountStateFromBlob(blob || loadCredential(alias));
  profile.authState = authState;
  if (!profile.email && authState?.authStatus?.email) {
    profile.email = authState.authStatus.email;
  }
  profile.updatedAt = new Date().toISOString();
  saveCatalog(catalog);
  return authState;
}

function applyClaudeGlobalAuthState(authState) {
  if (!authState || typeof authState !== 'object') return;
  const state = readClaudeGlobalState();
  const oauthAccount = authState.oauthAccount && typeof authState.oauthAccount === 'object'
    ? authState.oauthAccount
    : null;
  if (!oauthAccount) return;

  state.oauthAccount = oauthAccount;
  delete state.cachedExtraUsageDisabledReason;
  delete state.overageCreditGrantCache;
  writeClaudeGlobalState(state);
}

function readCodexbarConfig() {
  const fallback = { version: 1, providers: [] };
  const cfg = readJson(CODEXBAR_CONFIG, fallback);
  if (!cfg || typeof cfg !== 'object') return fallback;
  if (!Array.isArray(cfg.providers)) cfg.providers = [];
  if (!cfg.version) cfg.version = 1;
  return cfg;
}

function writeCodexbarConfig(config) {
  writeJsonAtomic(CODEXBAR_CONFIG, config);
}

function ensureCodexbarClaudeProvider(config) {
  let provider = config.providers.find((entry) => entry && entry.id === 'claude');
  if (!provider) {
    provider = { id: 'claude', enabled: true };
    config.providers.push(provider);
  }
  if (!provider.tokenAccounts || typeof provider.tokenAccounts !== 'object') {
    provider.tokenAccounts = { version: 1, activeIndex: 0, accounts: [] };
  }
  if (!Array.isArray(provider.tokenAccounts.accounts)) provider.tokenAccounts.accounts = [];
  if (!provider.tokenAccounts.version) provider.tokenAccounts.version = 1;
  return provider;
}

function syncCodexbarTokenAccount(alias, sessionKey, { setActive = false } = {}) {
  const label = profileCookieLabel(alias);
  const trimmedToken = String(sessionKey || '').trim();
  if (!trimmedToken) {
    throw new Error(`cannot sync codexbar token account for "${alias}" without a Claude sessionKey`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const config = readCodexbarConfig();
  const provider = ensureCodexbarClaudeProvider(config);
  const accounts = provider.tokenAccounts.accounts;
  const existingIndex = accounts.findIndex((entry) => String(entry?.label || '').trim() === label);
  if (existingIndex >= 0) {
    const prev = accounts[existingIndex] || {};
    accounts[existingIndex] = {
      id: prev.id || randomUUID(),
      label,
      token: trimmedToken,
      addedAt: Number.isFinite(Number(prev.addedAt)) ? Number(prev.addedAt) : nowSec,
      lastUsed: nowSec,
    };
  } else {
    accounts.push({
      id: randomUUID(),
      label,
      token: trimmedToken,
      addedAt: nowSec,
      lastUsed: nowSec,
    });
  }
  if (setActive) {
    const activeIdx = accounts.findIndex((entry) => String(entry?.label || '').trim() === label);
    provider.tokenAccounts.activeIndex = activeIdx >= 0 ? activeIdx : 0;
    provider.cookieSource = 'manual';
    provider.cookieHeader = `sessionKey=${trimmedToken}`;
  } else if (!Number.isFinite(Number(provider.tokenAccounts.activeIndex))) {
    provider.tokenAccounts.activeIndex = 0;
  }
  writeCodexbarConfig(config);
  return label;
}

function removeCodexbarTokenAccount(alias) {
  const label = profileCookieLabel(alias);
  const config = readCodexbarConfig();
  const provider = ensureCodexbarClaudeProvider(config);
  const accounts = provider.tokenAccounts.accounts || [];
  const next = accounts.filter((entry) => String(entry?.label || '').trim() !== label);
  if (next.length === accounts.length) return;
  provider.tokenAccounts.accounts = next;
  const activeIndex = Number(provider.tokenAccounts.activeIndex);
  if (!Number.isFinite(activeIndex) || activeIndex < 0 || activeIndex >= next.length) {
    provider.tokenAccounts.activeIndex = 0;
  }
  writeCodexbarConfig(config);
}

function firefoxCookieDbs() {
  const root = path.join(os.homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles');
  if (!fs.existsSync(root)) return [];
  const children = fs.readdirSync(root, { withFileTypes: true });
  return children
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, 'cookies.sqlite'))
    .filter((dbPath) => fs.existsSync(dbPath));
}

function readSessionKeyFromFirefox() {
  const dbs = firefoxCookieDbs();
  const query = [
    'SELECT value, host, path, lastAccessed',
    'FROM moz_cookies',
    "WHERE name = 'sessionKey' AND host LIKE '%claude.ai%'",
    'ORDER BY lastAccessed DESC',
    'LIMIT 1;',
  ].join(' ');
  for (const dbPath of dbs) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-firefox-'));
    const tmpDb = path.join(tmpDir, 'cookies.sqlite');
    try {
      fs.copyFileSync(dbPath, tmpDb);
      const walSrc = `${dbPath}-wal`;
      const shmSrc = `${dbPath}-shm`;
      if (fs.existsSync(walSrc)) fs.copyFileSync(walSrc, `${tmpDb}-wal`);
      if (fs.existsSync(shmSrc)) fs.copyFileSync(shmSrc, `${tmpDb}-shm`);
      const out = execFileSync('sqlite3', ['-separator', '\t', tmpDb, query], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (!out) continue;
      const [value = '', host = '', cookiePath = '', lastAccessed = ''] = out.split('\t');
      const sessionKey = String(value).trim();
      if (!sessionKey || !sessionKey.startsWith('sk-ant-')) continue;
      return {
        sessionKey,
        cookieHeader: `sessionKey=${sessionKey}`,
        source: 'firefox',
        host: host || null,
        path: cookiePath || null,
        profileCookieDb: dbPath,
        lastAccessed: Number(lastAccessed) || null,
        capturedAt: new Date().toISOString(),
      };
    } catch {
      // continue to next profile DB
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  throw new Error('No Claude sessionKey found in Firefox cookies. Log into claude.ai in Firefox and retry.');
}

function captureClaudeWebAuth() {
  return readSessionKeyFromFirefox();
}

function maskSecret(value) {
  const raw = String(value || '').trim();
  if (raw.length <= 10) return raw ? `${raw.slice(0, 2)}...` : '';
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

// ── keychain helpers ──────────────────────────────────────────────────────────

function keychainExport() {
  try {
    const blob = execFileSync('security', [
      'find-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-w',          // print password only
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!blob) throw new Error('empty credential returned from Keychain');
    return blob;
  } catch (err) {
    const msg = err.stderr || err.message || String(err);
    throw new Error(`Could not read Keychain entry "${KEYCHAIN_SERVICE}": ${msg}\nMake sure you are logged in with 'claude /login' first.`);
  }
}

function keychainDelete() {
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s', KEYCHAIN_SERVICE,
    ], { stdio: 'ignore' });
  } catch {
    // entry may not exist — that's fine
  }
}

function keychainImport(blob) {
  execFileSync('security', [
    'add-generic-password',
    '-s', KEYCHAIN_SERVICE,
    '-a', os.userInfo().username,
    '-w', blob,
    '-U',           // update if already exists (safety net)
  ], { stdio: 'ignore' });
}

// ── profile credential files ─────────────────────────────────────────────────

function credPath(alias) {
  return path.join(PROFILES_DIR, `${alias}.cred`);
}

function saveCredential(alias, blob) {
  ensureDir(PROFILES_DIR);
  fs.writeFileSync(credPath(alias), blob, { encoding: 'utf8', mode: 0o600 });
}

function loadCredential(alias) {
  const p = credPath(alias);
  if (!fs.existsSync(p)) {
    throw new Error(`No saved credential for profile "${alias}" at ${p}`);
  }
  return fs.readFileSync(p, 'utf8').trim();
}

function backupCurrent(blob) {
  ensureDir(BACKUP_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(BACKUP_DIR, `${ts}.cred`), blob, { encoding: 'utf8', mode: 0o600 });
}

// ── commands ──────────────────────────────────────────────────────────────────

function cmdAdd(alias) {
  if (!alias || !/^[a-z0-9_-]+$/i.test(alias)) {
    die('Usage: atc-profile add <alias>');
  }

  const catalog = loadCatalog();
  if (catalog.profiles[alias]) {
    die(`Profile "${alias}" already exists. Delete the .cred file manually to re-register.`);
  }

  const blob = keychainExport();
  const authState = fetchClaudeAccountStateFromBlob(blob);
  const observedEmail = authState?.authStatus?.email || null;
  if (!observedEmail) {
    die('Could not determine logged-in email from Claude OAuth account metadata.');
  }
  const normalizedEmail = observedEmail;
  const webAuth = captureClaudeWebAuth();

  // Warn if this credential is identical to an existing profile.
  for (const existing of Object.keys(catalog.profiles)) {
    const existingBlob = fs.existsSync(credPath(existing))
      ? fs.readFileSync(credPath(existing), 'utf8').trim()
      : null;
    if (existingBlob && existingBlob === blob) {
      die(`The currently-logged-in credential is identical to profile "${existing}".\nMake sure you have completed 'claude /login' with a different account before running 'add'.`);
    }
  }

  saveCredential(alias, blob);
  const codexbarAccountLabel = syncCodexbarTokenAccount(alias, webAuth.sessionKey, { setActive: !catalog.active });

  catalog.profiles[alias] = {
    displayName: alias,
    ...(normalizedEmail ? { email: normalizedEmail } : {}),
    authState,
    webAuth,
    codexbarAccountLabel,
    usageCache: placeholderUsageCache(normalizedEmail),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!catalog.active) catalog.active = alias;
  saveCatalog(catalog);

  console.log(`✓ Profile "${alias}" registered.${catalog.active === alias ? ' (set as active)' : ''}`);
  console.log(`  Email: ${normalizedEmail}`);
  console.log(`  Web token source: ${webAuth.source} (${webAuth.host || 'claude.ai'})`);
  console.log(`  Codexbar account label: ${codexbarAccountLabel}`);
}

function cmdList() {
  const catalog = loadCatalog();
  const profiles = Object.keys(catalog.profiles);
  if (profiles.length === 0) {
    console.log('No profiles registered. Run: atc-profile add <alias>');
    return;
  }
  console.log('Profiles:');
  for (const alias of profiles) {
    const active = alias === catalog.active ? ' *' : '  ';
    const { createdAt, email } = catalog.profiles[alias];
    const date = createdAt ? new Date(createdAt).toLocaleDateString() : '';
    const emailStr = email ? `  <${email}>` : '';
    console.log(`${active} ${alias}${emailStr}${date ? `  (added ${date})` : ''}`);
  }
}

function cmdCurrent() {
  const catalog = loadCatalog();
  if (!catalog.active) {
    console.log('No active profile.');
  } else {
    console.log(catalog.active);
  }
}

function switchProfile(alias, options = {}) {
  if (!alias) die('Usage: atc-profile use <alias>');
  const syncActive = !!options.syncActive;
  const force = !!options.force;

  const catalog = loadCatalog();
  if (!catalog.profiles[alias]) {
    die(`Unknown profile "${alias}". Run 'atc-profile list' to see available profiles.`);
  }
  if (!force && catalog.active === alias) {
    console.log(`Already on profile "${alias}".`);
    return;
  }

  // Optional: sync the currently active profile from Keychain before switching.
  // Disabled by default to avoid repeated Keychain password prompts.
  if (syncActive) {
    let currentBlob;
    try {
      currentBlob = keychainExport();
      backupCurrent(currentBlob);
    } catch {
      // If there is no current credential (e.g. logged out), skip saving it.
    }

    if (currentBlob && catalog.active) {
      const storedBlob = fs.existsSync(credPath(catalog.active))
        ? fs.readFileSync(credPath(catalog.active), 'utf8').trim()
        : null;
      const currentJson = JSON.parse(currentBlob);
      const storedJson = storedBlob ? JSON.parse(storedBlob) : null;
      const currentRefresh = currentJson?.claudeAiOauth?.refreshToken;
      const storedRefresh = storedJson?.claudeAiOauth?.refreshToken;
      if (storedRefresh && currentRefresh === storedRefresh) {
        // Same account, token may have rotated — update the stored cred.
        saveCredential(catalog.active, currentBlob);
        if (catalog.profiles[catalog.active]) {
          catalog.profiles[catalog.active].updatedAt = new Date().toISOString();
        }
      } else if (storedRefresh && currentRefresh !== storedRefresh) {
        console.warn(`  Warning: Keychain credential doesn't match stored profile "${catalog.active}" — skipping overwrite.`);
        console.warn(`  If you logged into a different account externally, re-run 'atc-profile add' to register it.`);
      }
    }
  }

  // 1. Load the target credential.
  const targetBlob = loadCredential(alias);
  const authState = ensureProfileAuthState(catalog, alias, targetBlob);

  // 2. Swap Keychain entry.
  keychainDelete();
  keychainImport(targetBlob);
  applyClaudeGlobalAuthState(authState);
  const token = String(catalog.profiles?.[alias]?.webAuth?.sessionKey || '').trim();
  if (token) syncCodexbarTokenAccount(alias, token, { setActive: true });

  // 3. Update catalog.
  catalog.active = alias;
  if (catalog.profiles[alias]) {
    catalog.profiles[alias].updatedAt = new Date().toISOString();
  }
  saveCatalog(catalog);

  console.log(`✓ Switched to profile "${alias}".`);
  console.log('  Active claude sessions will keep using the previous account.');
  console.log('  New sessions (including claude /login) will use this profile.');
}

function cmdRemove(alias) {
  if (!alias) die('Usage: atc-profile remove <alias>');

  const catalog = loadCatalog();
  if (!catalog.profiles[alias]) {
    die(`Unknown profile "${alias}". Run 'atc-profile list' to see available profiles.`);
  }
  if (catalog.active === alias) {
    die(`Cannot remove the active profile "${alias}". Switch to another profile first.`);
  }

  const cred = credPath(alias);
  if (fs.existsSync(cred)) fs.unlinkSync(cred);
  removeCodexbarTokenAccount(alias);
  delete catalog.profiles[alias];
  saveCatalog(catalog);

  console.log(`✓ Profile "${alias}" removed.`);
}

function cmdUse(alias, options = {}) {
  if (!alias) die('Usage: atc-profile use <alias>');
  const syncActive = !!options.syncActive;

  let catalog = loadCatalog();
  const profile = catalog.profiles?.[alias];
  if (!profile) {
    die(`Unknown profile "${alias}". Run 'atc-profile list' to see available profiles.`);
  }

  const expectedEmail = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
  if (!expectedEmail) {
    die(`Profile "${alias}" has no email registered.\nRe-register it with: atc-profile add ${alias}`);
  }

  switchProfile(alias, { force: true, syncActive });
  catalog = loadCatalog();

  let parsed;
  try {
    const out = execFileSync('claude', ['auth', 'status', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Number(process.env.ATC_CLAUDE_AUTH_STATUS_TIMEOUT_MS || 8000),
      maxBuffer: 512 * 1024,
    }).trim();
    parsed = JSON.parse(out);
  } catch (error) {
    // Fallback to slower interactive status parser when auth status is unavailable.
    const parserPath = path.join(__dirname, 'claude-status-parser.mjs');
    if (!fs.existsSync(parserPath)) {
      const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
      const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
      const detail = stderr || stdout || error.message || 'unknown auth status failure';
      die(`use failed: could not read Claude auth status (${detail})`);
    }
    try {
      const out = execFileSync('node', [parserPath, '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: Number(process.env.ATC_CLAUDE_STATUS_TIMEOUT_MS || 45000) + 5000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          ATC_CLAUDE_STATUS_TIMEOUT_MS: String(process.env.ATC_CLAUDE_STATUS_TIMEOUT_MS || 45000),
        },
      }).trim();
      parsed = JSON.parse(out);
    } catch (fallbackErr) {
      const stderr = typeof fallbackErr?.stderr === 'string' ? fallbackErr.stderr.trim() : '';
      const stdout = typeof fallbackErr?.stdout === 'string' ? fallbackErr.stdout.trim() : '';
      const detail = stderr || stdout || fallbackErr.message || 'unknown parser failure';
      die(`use failed: could not read Claude status (${detail})`);
    }
  }

  const observedEmail = typeof parsed?.email === 'string' ? parsed.email.trim().toLowerCase() : '';
  if (!observedEmail) {
    die('use failed: /status returned no email.');
  }

  if (observedEmail !== expectedEmail) {
    console.error(`✗ Use failed for "${alias}".`);
    console.error(`  Expected: ${expectedEmail}`);
    console.error(`  Observed: ${observedEmail}`);
    process.exit(2);
  }

  console.log(`✓ Use passed for "${alias}".`);
  console.log(`  Email: ${observedEmail}`);
  if (parsed?.orgName || parsed?.organization) {
    console.log(`  Organization: ${parsed.orgName || parsed.organization}`);
  }
}

function cmdWipe(confirmYes) {
  if (!confirmYes) {
    die('Refusing to wipe credentials without --yes.\nUsage: atc-profile wipe --yes');
  }

  // Delete the active Claude OAuth credential in macOS Keychain.
  keychainDelete();

  // Remove saved profile credentials and catalog.
  if (fs.existsSync(PROFILES_DIR)) {
    for (const entry of fs.readdirSync(PROFILES_DIR)) {
      const full = path.join(PROFILES_DIR, entry);
      // Keep directory removal simple and explicit.
      fs.rmSync(full, { recursive: true, force: true });
    }
  }

  console.log('✓ Wiped Claude Keychain credential and all saved atc-profile credentials.');
  console.log('  Next step: run claude, then /login, then atc-profile add <alias>.');
}

function cmdProbeWeb() {
  const webAuth = captureClaudeWebAuth();
  console.log('✓ Claude web token found.');
  console.log(`  Source: ${webAuth.source}`);
  if (webAuth.host) console.log(`  Host: ${webAuth.host}`);
  console.log(`  sessionKey: ${maskSecret(webAuth.sessionKey)}`);
  if (webAuth.profileCookieDb) console.log(`  Cookie DB: ${webAuth.profileCookieDb}`);
}

function cmdSyncWeb(alias) {
  if (!alias) die('Usage: atc-profile sync-web <alias>');
  const catalog = loadCatalog();
  if (!catalog.profiles?.[alias]) {
    die(`Unknown profile "${alias}". Run 'atc-profile list' to see available profiles.`);
  }
  const webAuth = captureClaudeWebAuth();
  catalog.profiles[alias].webAuth = webAuth;
  catalog.profiles[alias].codexbarAccountLabel = syncCodexbarTokenAccount(alias, webAuth.sessionKey, {
    setActive: catalog.active === alias,
  });
  catalog.profiles[alias].updatedAt = new Date().toISOString();
  saveCatalog(catalog);

  console.log(`✓ Synced Claude web token for "${alias}".`);
  console.log(`  Source: ${webAuth.source}`);
  console.log(`  sessionKey: ${maskSecret(webAuth.sessionKey)}`);
  console.log(`  Codexbar account label: ${catalog.profiles[alias].codexbarAccountLabel}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const [,, command, ...rest] = process.argv;
// Parse command flags from remaining args
function parseArgs(args) {
  const result = { positional: [], yes: false, syncActive: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes') {
      result.yes = true;
    } else if (args[i] === '--sync-active') {
      result.syncActive = true;
    } else {
      result.positional.push(args[i]);
    }
  }
  return result;
}
const { positional, yes: confirmYes, syncActive } = parseArgs(rest);
const arg = positional[0];
switch (command) {
  case 'add':     cmdAdd(arg); break;
  case 'list':    cmdList(); break;
  case 'current': cmdCurrent(); break;
  case 'use':     cmdUse(arg, { syncActive }); break;
  case 'remove':  cmdRemove(arg); break;
  case 'wipe':    cmdWipe(confirmYes); break;
  case 'probe-web': cmdProbeWeb(); break;
  case 'sync-web': cmdSyncWeb(arg); break;
  default:
    console.error(`atc-profile — Claude account profile manager

Commands:
  add <alias>     register the currently-logged-in account under <alias>
  list            show all profiles (* = active)
  current         print the active profile alias
  use <alias> [--sync-active] switch + validate /status email matches alias email
  remove <alias>  delete a profile (cannot remove the active profile)
  wipe --yes      delete Claude Keychain cred + all saved atc-profile creds/catalog
  probe-web       print detected Claude web sessionKey from Firefox cookies
  sync-web <alias> capture current Firefox Claude sessionKey into an existing profile
`);
    process.exit(command ? 1 : 0);
}
