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
import { pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const PROFILES_DIR = path.join(os.homedir(), '.claude-profiles');
const PROFILES_JSON = path.join(PROFILES_DIR, 'profiles.json');
const BACKUP_DIR = path.join(PROFILES_DIR, '.backup');
const CODEXBAR_CONFIG = path.join(os.homedir(), '.codexbar', 'config.json');
const CLAUDE_GLOBAL_STATE = path.join(os.homedir(), '.claude.json');
const CLAUDE_OAUTH_ACCOUNT_URL = 'https://api.anthropic.com/api/oauth/account';
// Upstream claude-code (constants/oauth.ts) migrated the prod TOKEN_URL from
// console.anthropic.com to platform.claude.com. Both still resolve, but we
// follow upstream so we don't get caught by a future deprecation.
const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Match upstream isOAuthTokenExpired buffer (5 min): ensures we refresh in the
// same window Claude CLI would, so we never race validating a token that's
// about to expire under the CLI's feet.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// Matches upstream CLAUDE_AI_OAUTH_SCOPES. Sent on refresh so the server can
// transparently expand scopes when Anthropic adds new ones (e.g. user:file_upload
// was added this way) without requiring a re-login.
const CLAUDE_AI_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];
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
      '-w', '\n%{http_code}',
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

  const lastNewline = raw.lastIndexOf('\n');
  const httpStatus = lastNewline >= 0 ? Number(raw.slice(lastNewline + 1).trim()) : 0;
  const responseBody = lastNewline >= 0 ? raw.slice(0, lastNewline) : raw;

  let payload;
  try {
    payload = responseBody ? JSON.parse(responseBody) : null;
  } catch {
    throw new Error(`Claude account metadata was not valid JSON (HTTP ${httpStatus || 'unknown'})`);
  }

  // A 401 / 403 here means the access token is dead — surface that instead of
  // silently returning authState with a null email, which lets callers mistake
  // "token invalid" for "identity cached but unconfirmed".
  if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
    const errType = payload?.error?.type || payload?.error || `http_${httpStatus || 'unknown'}`;
    const errMsg = payload?.error?.message || payload?.error_description || payload?.message || String(responseBody || '').slice(0, 200);
    const err = new Error(`Claude OAuth account endpoint rejected access token (${errType}): ${errMsg}`);
    err.oauthError = errType;
    err.httpStatus = httpStatus;
    throw err;
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

function extractClaudeOauthAccessToken(blob) {
  const parsed = parseCredentialBlob(blob);
  const token = String(parsed?.claudeAiOauth?.accessToken || '').trim();
  if (!token) return null;
  return token;
}

export function blobExpiresAtMs(blob) {
  const parsed = parseCredentialBlob(blob);
  const raw = parsed?.claudeAiOauth?.expiresAt;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  // Tolerate both seconds-since-epoch and ms-since-epoch storage.
  return raw < 1e12 ? raw * 1000 : raw;
}

export function blobNeedsRefresh(blob, skewMs = REFRESH_SKEW_MS) {
  const exp = blobExpiresAtMs(blob);
  if (exp == null) return true;
  return Date.now() + skewMs >= exp;
}

// Normalize the error shape returned by console.anthropic.com/v1/oauth/token.
// The endpoint can return OAuth-standard {error:"invalid_grant", error_description}
// OR Anthropic-standard {error:{type:"rate_limit_error", message}}. Handle both.
export function classifyRefreshError(httpStatus, payload, responseBody) {
  const err = payload && typeof payload === 'object' ? payload.error : null;
  const code = typeof err === 'string'
    ? err
    : (err && typeof err === 'object' ? String(err.type || err.code || '') : '') || `http_${httpStatus || 'unknown'}`;
  const desc = (typeof err === 'object' && err ? err.message : null)
    || (payload && typeof payload === 'object' ? payload.error_description : null)
    || (payload && typeof payload === 'object' ? payload.message : null)
    || String(responseBody || '').slice(0, 200);
  return { code, desc };
}

// OAuth refresh-token errors that mean "this refresh token is dead, re-login
// is the only recovery." Network/rate-limit/5xx errors are non-fatal and should
// let the caller fall back to the unrefreshed blob.
export function isFatalRefreshError(code, httpStatus) {
  if (code === 'invalid_grant') return true;
  if (code === 'invalid_request') return true;
  if (code === 'invalid_client') return true;
  if (code === 'unauthorized_client') return true;
  if (code === 'missing_refresh_token') return true;
  if (httpStatus === 401) return true;
  // 400 is ambiguous: OAuth errors use 400 for invalid_grant, but so does
  // malformed input. The code check above catches the real invalid_grant case.
  return false;
}

// Pure: turn the HTTP response from /v1/oauth/token into a refreshed cred blob,
// preserving all non-token fields (scopes, subscriptionType, etc.) from the
// previous blob. Returns the same shape that Keychain expects.
export function buildRefreshedBlob(prevParsed, payload, nowMs = Date.now()) {
  const prevOauth = (prevParsed && typeof prevParsed === 'object' && prevParsed.claudeAiOauth)
    ? prevParsed.claudeAiOauth
    : {};
  const access = String(payload?.access_token || '').trim();
  const refresh = String(payload?.refresh_token || '').trim() || String(prevOauth.refreshToken || '').trim();
  const expiresInSec = Number(payload?.expires_in);
  if (!access) {
    const err = new Error('OAuth refresh response missing access_token');
    err.oauthError = 'malformed_response';
    throw err;
  }
  if (!Number.isFinite(expiresInSec) || expiresInSec <= 0) {
    const err = new Error('OAuth refresh response missing or invalid expires_in');
    err.oauthError = 'malformed_response';
    throw err;
  }
  if (!refresh) {
    const err = new Error('OAuth refresh response has no refresh_token and none was saved locally');
    err.oauthError = 'malformed_response';
    throw err;
  }
  return {
    ...(prevParsed && typeof prevParsed === 'object' ? prevParsed : {}),
    claudeAiOauth: {
      ...prevOauth,
      accessToken: access,
      refreshToken: refresh,
      expiresAt: nowMs + expiresInSec * 1000,
    },
  };
}

// Pure: parse the `curl -w '\n%{http_code}'` output produced by the refresh call.
export function parseRefreshResponse(raw) {
  const str = String(raw || '').trim();
  const lastNewline = str.lastIndexOf('\n');
  const httpStatus = lastNewline >= 0 ? Number(str.slice(lastNewline + 1).trim()) : 0;
  const responseBody = lastNewline >= 0 ? str.slice(0, lastNewline) : str;
  let payload = null;
  try {
    payload = responseBody ? JSON.parse(responseBody) : null;
  } catch {
    // non-JSON response; caller treats as error
  }
  return { httpStatus, responseBody, payload };
}

function refreshCredentialBlob(blob) {
  const parsed = parseCredentialBlob(blob);
  const refreshToken = String(parsed?.claudeAiOauth?.refreshToken || '').trim();
  if (!refreshToken) {
    const err = new Error('saved credential is missing Claude OAuth refreshToken');
    err.oauthError = 'missing_refresh_token';
    throw err;
  }

  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    scope: CLAUDE_AI_OAUTH_SCOPES.join(' '),
  });

  let raw;
  try {
    raw = execFileSync('curl', [
      '-sS',
      '-w', '\n%{http_code}',
      '--max-time', String(Number(process.env.ATC_CLAUDE_REFRESH_TIMEOUT_SEC || 15)),
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-d', body,
      CLAUDE_OAUTH_TOKEN_URL,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 }).trim();
  } catch (error) {
    const detail = typeof error?.stderr === 'string' && error.stderr.trim()
      ? error.stderr.trim()
      : error.message || 'unknown refresh failure';
    const err = new Error(`OAuth refresh request failed: ${detail}`);
    err.oauthError = 'network_error';
    throw err;
  }

  const { httpStatus, responseBody, payload } = parseRefreshResponse(raw);

  if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
    const { code, desc } = classifyRefreshError(httpStatus, payload, responseBody);
    const err = new Error(`OAuth refresh rejected (${code}): ${desc}`);
    err.oauthError = code;
    err.httpStatus = httpStatus;
    throw err;
  }

  const next = buildRefreshedBlob(parsed, payload);
  return JSON.stringify(next);
}

function classifyClaudeCodexbarToken(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower.startsWith('bearer sk-ant-oat') || lower.startsWith('sk-ant-oat')) return 'oauth';
  if (value.includes('=') || lower.includes('cookie:') || lower.startsWith('sk-ant-sid')) return 'web';
  return 'unknown';
}

function resolveCodexbarTokenForProfile(profile, blob = null) {
  const profileToken = String(profile?.codexbarToken?.token || '').trim();
  if (profileToken && classifyClaudeCodexbarToken(profileToken) === 'oauth') return profileToken;
  const oauth = extractClaudeOauthAccessToken(blob);
  if (oauth) return oauth;
  const sessionKey = String(profile?.webAuth?.sessionKey || '').trim();
  if (sessionKey) return sessionKey;
  if (profileToken) return profileToken;
  return null;
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

function syncCodexbarTokenAccount(alias, token, { setActive = false, webAuth = null } = {}) {
  const label = profileCookieLabel(alias);
  const trimmedToken = String(token || '').trim();
  if (!trimmedToken) {
    throw new Error(`cannot sync codexbar token account for "${alias}" without a token`);
  }
  const tokenKind = classifyClaudeCodexbarToken(trimmedToken);
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
    // For session-key accounts, keep manual cookie mode pointed at this alias.
    // For OAuth accounts, disable cookie mode and clear any stale manual header.
    if (tokenKind === 'oauth') {
      provider.cookieSource = 'off';
      delete provider.cookieHeader;
    } else {
      const sessionKey = String(webAuth?.sessionKey || '').trim() || trimmedToken;
      provider.cookieSource = 'manual';
      provider.cookieHeader = sessionKey.includes('=') ? sessionKey : `sessionKey=${sessionKey}`;
    }
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

async function cmdAdd(alias) {
  if (!alias || !/^[a-z0-9_-]+$/i.test(alias)) {
    die('Usage: atc-profile add <alias>');
  }

  const catalog = loadCatalog();
  const existingProfile = catalog.profiles[alias] || null;

  const blob = keychainExport();
  const authState = fetchClaudeAccountStateFromBlob(blob);
  const observedEmail = authState?.authStatus?.email || null;
  if (!observedEmail) {
    die('Could not determine logged-in email from Claude OAuth account metadata.');
  }
  const normalizedEmail = observedEmail;

  // Drift warning: if the user ran `claude /logout && /login` externally
  // without going through `rotate`, the previously-active profile's rotated
  // tokens are gone from keychain. Call that out loudly — next switch-back
  // to that profile may fail with invalid_grant.
  if (catalog.active && catalog.active !== alias) {
    const prevProfile = catalog.profiles[catalog.active];
    const prevExpectedEmail = String(prevProfile?.email || '').trim().toLowerCase();
    if (prevExpectedEmail && prevExpectedEmail !== String(normalizedEmail).trim().toLowerCase()) {
      console.warn('');
      console.warn('⚠  Possible token loss detected.');
      console.warn(`   Active profile "${catalog.active}" is bound to ${prevExpectedEmail}.`);
      console.warn(`   Keychain now holds ${normalizedEmail} — a different account.`);
      console.warn(`   The rotated tokens for "${catalog.active}" were NOT saved before the swap.`);
      console.warn(`   Next switch to "${catalog.active}" may fail; re-login may be required.`);
      console.warn('');
      console.warn('   Prefer this safer flow next time:');
      console.warn(`     atc-profile rotate ${alias}    # saves current profile, then guides login`);
      console.warn('');
      if (process.stdin.isTTY) {
        const proceed = await promptYesNo(`   Proceed with adding "${alias}" anyway? [y/N]: `);
        if (!proceed) {
          console.log('Aborted.');
          process.exit(1);
        }
      } else {
        console.warn('   (non-interactive stdin: proceeding without confirmation)');
      }
    }
  }
  const webAuth = captureClaudeWebAuth();
  const oauthAccessToken = extractClaudeOauthAccessToken(blob);
  const codexbarToken = oauthAccessToken || webAuth.sessionKey;

  // Warn if this credential is identical to a different existing profile.
  for (const existing of Object.keys(catalog.profiles)) {
    if (existing === alias) continue;
    const existingBlob = fs.existsSync(credPath(existing))
      ? fs.readFileSync(credPath(existing), 'utf8').trim()
      : null;
    if (existingBlob && existingBlob === blob) {
      die(`The currently-logged-in credential is identical to profile "${existing}".\nMake sure you have completed 'claude /login' with a different account before running 'add'.`);
    }
  }

  // Existing alias can be refreshed in-place, but do not silently rebind to a
  // different account email.
  if (existingProfile) {
    const existingEmail = String(existingProfile.email || '').trim().toLowerCase();
    if (existingEmail && existingEmail !== normalizedEmail) {
      die(
        `Profile "${alias}" is bound to ${existingEmail}, but current login is ${normalizedEmail}.\n` +
        `Use a different alias, or remove "${alias}" first to rebind it.`
      );
    }
  }

  saveCredential(alias, blob);
  const codexbarAccountLabel = syncCodexbarTokenAccount(alias, codexbarToken, { setActive: true, webAuth });

  catalog.profiles[alias] = {
    ...(existingProfile && typeof existingProfile === 'object' ? existingProfile : {}),
    displayName: alias,
    ...(normalizedEmail ? { email: normalizedEmail } : {}),
    authState,
    webAuth,
    codexbarToken: {
      kind: classifyClaudeCodexbarToken(codexbarToken) || 'unknown',
      token: codexbarToken,
      capturedAt: new Date().toISOString(),
    },
    codexbarAccountLabel,
    usageCache: placeholderUsageCache(normalizedEmail),
    createdAt: existingProfile?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // `add` represents "register what I am currently logged into right now".
  // Make the newly added profile active immediately to match CLI + web state.
  catalog.active = alias;
  applyClaudeGlobalAuthState(authState);
  saveCatalog(catalog);

  const verb = existingProfile ? 'updated' : 'registered';
  console.log(`✓ Profile "${alias}" ${verb}.${catalog.active === alias ? ' (set as active)' : ''}`);
  console.log(`  Email: ${normalizedEmail}`);
  console.log(`  Web token source: ${webAuth.source} (${webAuth.host || 'claude.ai'})`);
  console.log(`  Codexbar token type: ${classifyClaudeCodexbarToken(codexbarToken) || 'unknown'}`);
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
  // Default: capture the currently-active profile's rotated tokens before swap,
  // so the on-disk .cred stays in sync with what Keychain has been rotating.
  // Opt out with { syncActive: false } if Keychain password prompts are a problem.
  const syncActive = options.syncActive !== false;
  const force = !!options.force;

  const catalog = loadCatalog();
  if (!catalog.profiles[alias]) {
    die(`Unknown profile "${alias}". Run 'atc-profile list' to see available profiles.`);
  }
  if (!force && catalog.active === alias) {
    console.log(`Already on profile "${alias}".`);
    return { authState: catalog.profiles[alias]?.authState || null };
  }

  // NOTE: sync-active used to run here, at the top of switchProfile. It has
  // been moved down to just before keychainDelete so we capture the keychain
  // as close as possible to the swap — narrowing the window in which another
  // Claude process could rotate the RT between capture and swap.

  // 1. Load the target credential. Refresh tokens are single-use and rotate,
  //    so .cred snapshots can drift: the access token may be dead well before
  //    its stored expiresAt (another claude process rotated it away). We handle
  //    both signals — near-expiry proactively, and live 401 reactively.
  let targetBlob = loadCredential(alias);
  let refreshed = false;

  const attemptRefresh = () => {
    const next = refreshCredentialBlob(targetBlob);
    saveCredential(alias, next);
    targetBlob = next;
    refreshed = true;
  };

  const fatalRefreshMessage = (error) =>
    `Profile "${alias}" has a dead refresh token (${error?.oauthError || 'unauthorized'}).\n` +
    `Recover with:\n` +
    `  1) claude /logout\n` +
    `  2) close other running claude processes (tmux, IDE, MCP)\n` +
    `  3) restart your shell, then: claude /login\n` +
    `  4) atc-profile add ${alias}\n` +
    `Original error: ${error.message}`;

  if (blobNeedsRefresh(targetBlob)) {
    try {
      attemptRefresh();
    } catch (error) {
      const code = error?.oauthError || '';
      if (isFatalRefreshError(code, error?.httpStatus)) {
        die(fatalRefreshMessage(error));
      }
      // Non-fatal (network / rate-limit / malformed): warn and let validation
      // below decide. If the access token is still valid, the swap succeeds.
      console.warn(`  Warning: proactive refresh for "${alias}" failed: ${error.message}`);
    }
  }

  // 2. Live validation with reactive refresh on 401/403. This is the key
  //    self-healing path: expiresAt lies when another claude process rotated
  //    our access token behind our back, so we can't trust it as a refresh
  //    trigger — we have to ask the server.
  let authState;
  try {
    authState = fetchClaudeAccountStateFromBlob(targetBlob);
  } catch (error) {
    const unauthorized = error?.httpStatus === 401 || error?.httpStatus === 403;
    if (!unauthorized) throw error;

    if (refreshed) {
      // We already refreshed and the new access token still got 401 — something
      // is wrong beyond snapshot drift (revoked grant, account disabled, etc.).
      die(
        `Profile "${alias}" access token is invalid even after refresh.\n` +
        `The refresh endpoint returned new tokens but the account endpoint\n` +
        `still rejects them. The OAuth grant may have been revoked.\n` +
        `Recover with: claude /logout && claude /login && atc-profile add ${alias}\n` +
        `Original error: ${error.message}`
      );
    }

    // Reactive refresh: access token was dead despite expiresAt looking fine.
    console.warn(`  Access token rejected — attempting reactive refresh...`);
    try {
      attemptRefresh();
    } catch (refreshErr) {
      const code = refreshErr?.oauthError || '';
      if (isFatalRefreshError(code, refreshErr?.httpStatus)) {
        die(fatalRefreshMessage(refreshErr));
      }
      die(
        `Profile "${alias}" access token is invalid and reactive refresh failed: ${refreshErr.message}\n` +
        `This usually means the refresh endpoint rate-limited us (429) or the\n` +
        `network is unreachable. Recovery:\n` +
        `  1) wait ~15 min if rate-limited, then: atc-profile use ${alias}\n` +
        `  2) or re-login: claude /logout && claude /login && atc-profile add ${alias}`
      );
    }

    try {
      authState = fetchClaudeAccountStateFromBlob(targetBlob);
    } catch (retryError) {
      die(
        `Profile "${alias}" still rejected after reactive refresh (${retryError?.httpStatus || '?'}).\n` +
        `Recover with: claude /logout && claude /login && atc-profile add ${alias}\n` +
        `Original error: ${retryError.message}`
      );
    }
  }
  const profile = catalog.profiles[alias];
  if (profile) {
    profile.authState = authState;
    if (!profile.email && authState?.authStatus?.email) {
      profile.email = authState.authStatus.email;
    }
  }

  // 2.5 Sync-active: freeze the live keychain back to <active>.cred before we
  //     swap it out. Using identity verification (not RT equality) so that
  //     background RT rotations — which are the normal case — don't cause the
  //     save to be skipped, which is how the .cred silently goes stale and
  //     strands the user with a consumed single-use token on next switch-back.
  if (syncActive && catalog.active && catalog.active !== alias) {
    let currentBlob;
    try {
      currentBlob = keychainExport();
      backupCurrent(currentBlob);
    } catch {
      // Keychain empty (e.g. user already ran /logout) — nothing to save.
    }

    if (currentBlob) {
      const activeProfile = catalog.profiles[catalog.active];
      const expectedEmail = typeof activeProfile?.email === 'string'
        ? activeProfile.email.trim().toLowerCase()
        : '';

      // If keychain AT is expired, refresh in place first. This rotates the RT,
      // so the fresh one must be written back to keychain AND saved to .cred —
      // losing the freshly-rotated RT is exactly the bug this code prevents.
      if (blobNeedsRefresh(currentBlob)) {
        try {
          const refreshed = refreshCredentialBlob(currentBlob);
          keychainImport(refreshed);
          currentBlob = refreshed;
        } catch (error) {
          console.warn(`  Warning: sync-active refresh for "${catalog.active}" failed: ${error.message}`);
        }
      }

      if (expectedEmail) {
        let observedEmail = null;
        try {
          const activeAuthState = fetchClaudeAccountStateFromBlob(currentBlob);
          observedEmail = String(activeAuthState?.authStatus?.email || '').trim().toLowerCase();
        } catch (error) {
          console.warn(`  Warning: could not verify keychain identity for "${catalog.active}": ${error.message}`);
          console.warn(`  Skipping cred save to avoid drift risk.`);
        }

        if (observedEmail && observedEmail === expectedEmail) {
          saveCredential(catalog.active, currentBlob);
          if (activeProfile) {
            activeProfile.updatedAt = new Date().toISOString();
          }
        } else if (observedEmail && observedEmail !== expectedEmail) {
          console.warn(`  Warning: Keychain holds ${observedEmail}, but active profile "${catalog.active}" is bound to ${expectedEmail}.`);
          console.warn(`  Skipping cred save to avoid clobbering with wrong account's credentials.`);
        }
      } else {
        // Legacy profile with no recorded email — save without identity check
        // to preserve the pre-fix-#2 behavior.
        saveCredential(catalog.active, currentBlob);
        if (activeProfile) {
          activeProfile.updatedAt = new Date().toISOString();
        }
      }
    }
  }

  // 3. Swap Keychain entry.
  keychainDelete();
  keychainImport(targetBlob);
  applyClaudeGlobalAuthState(authState);
  const token = resolveCodexbarTokenForProfile(catalog.profiles?.[alias], targetBlob);
  if (token) {
    catalog.profiles[alias].codexbarToken = {
      kind: classifyClaudeCodexbarToken(token) || 'unknown',
      token,
      capturedAt: new Date().toISOString(),
    };
    syncCodexbarTokenAccount(alias, token, { setActive: true, webAuth: catalog.profiles?.[alias]?.webAuth || null });
  }

  // 4. Update catalog.
  catalog.active = alias;
  if (catalog.profiles[alias]) {
    catalog.profiles[alias].updatedAt = new Date().toISOString();
  }
  saveCatalog(catalog);

  console.log(`✓ Switched to profile "${alias}".${refreshed ? ' (refreshed OAuth token)' : ''}`);
  console.log('  Any running claude sessions will use this account on their next API call.');
  return { authState };
}

async function promptYesNo(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(message);
    return /^y(es)?$/i.test(String(answer || '').trim());
  } finally {
    rl.close();
  }
}

// Identity-verified freeze of the currently-active keychain into <active>.cred.
// Returns the blob that was saved (for potential rollback), or null if nothing
// was saved. Aborts the process on identity mismatch — the caller should treat
// that as "cannot safely continue" and recover manually.
function freezeActiveKeychain(catalog, { allowLegacy = true } = {}) {
  const activeAlias = catalog.active;
  if (!activeAlias) return null;
  let blob;
  try {
    blob = keychainExport();
  } catch {
    return null; // keychain already empty
  }
  const activeProfile = catalog.profiles?.[activeAlias];
  const expectedEmail = typeof activeProfile?.email === 'string'
    ? activeProfile.email.trim().toLowerCase()
    : '';
  if (blobNeedsRefresh(blob)) {
    try {
      const refreshed = refreshCredentialBlob(blob);
      keychainImport(refreshed);
      blob = refreshed;
    } catch (error) {
      console.warn(`  Warning: could not refresh "${activeAlias}" before freeze: ${error.message}`);
    }
  }
  if (expectedEmail) {
    let observedEmail = null;
    try {
      const authState = fetchClaudeAccountStateFromBlob(blob);
      observedEmail = String(authState?.authStatus?.email || '').trim().toLowerCase();
    } catch (error) {
      console.warn(`  Warning: identity check for "${activeAlias}" failed: ${error.message}`);
    }
    if (observedEmail && observedEmail === expectedEmail) {
      backupCurrent(blob);
      saveCredential(activeAlias, blob);
      if (activeProfile) activeProfile.updatedAt = new Date().toISOString();
      return blob;
    }
    if (observedEmail && observedEmail !== expectedEmail) {
      console.error(`✗ Keychain holds ${observedEmail}, not the expected ${expectedEmail} for active profile "${activeAlias}".`);
      console.error(`  Aborting to avoid clobbering ${activeAlias}.cred with the wrong account's credentials.`);
      console.error(`  To register the current login, run: atc-profile add <alias>`);
      process.exit(1);
    }
    console.warn(`  Warning: could not verify keychain identity; skipping cred save for "${activeAlias}".`);
    return null;
  }
  if (allowLegacy) {
    backupCurrent(blob);
    saveCredential(activeAlias, blob);
    if (activeProfile) activeProfile.updatedAt = new Date().toISOString();
    return blob;
  }
  return null;
}

// rotate — single-phase guided account swap.
//
// The problem this solves: `claude /logout && claude /login` mutates the
// keychain externally, which means if you ran it while profile X was active,
// X's freshly-rotated refresh token in keychain is gone (overwritten) before
// atc-profile ever gets a chance to save it. `rotate` owns the whole swap:
// it freezes X's keychain state first, clears the keychain so no process can
// consume the saved RT, waits while the user runs claude /login, then
// registers the new login under <alias>. If the user aborts (answers 'n'),
// the saved keychain blob is restored.
async function cmdRotate(alias) {
  if (!alias || !/^[a-z0-9_-]+$/i.test(alias)) {
    die('Usage: atc-profile rotate <alias>');
  }

  const catalog = loadCatalog();
  const activeAlias = catalog.active;
  const activeProfile = activeAlias ? catalog.profiles?.[activeAlias] : null;
  const activeEmail = activeProfile?.email || null;

  if (activeAlias) {
    console.log(`  Active profile: ${activeAlias}${activeEmail ? ` <${activeEmail}>` : ''}`);
  } else {
    console.log('  No active profile recorded.');
  }

  // Phase 1a — freeze current keychain → active.cred
  const savedBlob = freezeActiveKeychain(catalog);
  if (savedBlob) {
    console.log(`✓ Froze "${activeAlias}" keychain state → ${activeAlias}.cred`);
    saveCatalog(catalog);
  } else if (activeAlias) {
    console.log(`  (nothing to freeze for "${activeAlias}" — keychain was empty or unmatched)`);
  }

  // Phase 1b — clear keychain so no running claude process can consume the RT
  keychainDelete();
  console.log('✓ Cleared keychain.');

  // Phase 2 — user logs in as the target account
  console.log('');
  console.log('Now, in a separate terminal:');
  console.log('  1. Close any running claude processes (tmux panes, IDE, MCP)');
  console.log('  2. Run: claude /login');
  console.log(`     Log in as the account you want to register as "${alias}".`);
  console.log('');

  const loggedIn = await promptYesNo('Did you complete claude /login? [y/N]: ');

  if (!loggedIn) {
    if (savedBlob) {
      try {
        keychainImport(savedBlob);
        console.log(`✓ Restored keychain to "${activeAlias}" — nothing changed.`);
        return;
      } catch (error) {
        console.error(`✗ Could not restore keychain: ${error.message}`);
        console.error(`  ${activeAlias}.cred is intact — recover with: atc-profile use ${activeAlias}`);
        process.exit(1);
      }
    }
    console.log('  Keychain remains empty. Nothing to roll back.');
    return;
  }

  // Phase 3 — read & validate new keychain credential
  let newBlob;
  try {
    newBlob = keychainExport();
  } catch {
    console.error('✗ Keychain is still empty — claude /login did not complete.');
    if (activeAlias) {
      console.error(`  To restore "${activeAlias}", run: atc-profile use ${activeAlias}`);
    }
    process.exit(1);
  }

  const newAuthState = fetchClaudeAccountStateFromBlob(newBlob);
  const observedEmail = typeof newAuthState?.authStatus?.email === 'string'
    ? newAuthState.authStatus.email.trim().toLowerCase()
    : null;
  if (!observedEmail) {
    die('Could not determine logged-in email from Claude OAuth account metadata.');
  }

  // Guard: refuse if this email is already registered under a different alias
  for (const [otherAlias, otherProfile] of Object.entries(catalog.profiles || {})) {
    if (otherAlias === alias) continue;
    const otherEmail = String(otherProfile?.email || '').trim().toLowerCase();
    if (otherEmail && otherEmail === observedEmail) {
      console.error(`✗ Email ${observedEmail} is already registered as profile "${otherAlias}".`);
      console.error(`  Use a different alias, or remove "${otherAlias}" first.`);
      process.exit(1);
    }
  }

  // Guard: refuse if re-registering <alias> under a different email than its existing binding
  const existingProfile = catalog.profiles?.[alias] || null;
  if (existingProfile) {
    const existingEmail = String(existingProfile.email || '').trim().toLowerCase();
    if (existingEmail && existingEmail !== observedEmail) {
      console.error(`✗ Profile "${alias}" is bound to ${existingEmail}, but new login is ${observedEmail}.`);
      console.error(`  Use a different alias, or remove "${alias}" first to rebind it.`);
      process.exit(1);
    }
  }

  // Phase 4 — register
  const webAuth = captureClaudeWebAuth();
  const oauthAccessToken = extractClaudeOauthAccessToken(newBlob);
  const codexbarToken = oauthAccessToken || webAuth.sessionKey;

  saveCredential(alias, newBlob);
  const codexbarAccountLabel = syncCodexbarTokenAccount(alias, codexbarToken, { setActive: true, webAuth });

  catalog.profiles[alias] = {
    ...(existingProfile && typeof existingProfile === 'object' ? existingProfile : {}),
    displayName: alias,
    email: observedEmail,
    authState: newAuthState,
    webAuth,
    codexbarToken: {
      kind: classifyClaudeCodexbarToken(codexbarToken) || 'unknown',
      token: codexbarToken,
      capturedAt: new Date().toISOString(),
    },
    codexbarAccountLabel,
    usageCache: existingProfile?.usageCache || placeholderUsageCache(observedEmail),
    createdAt: existingProfile?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  catalog.active = alias;
  applyClaudeGlobalAuthState(newAuthState);
  saveCatalog(catalog);

  const verb = existingProfile ? 'Re-registered' : 'Registered';
  console.log(`✓ ${verb} "${alias}" (${observedEmail}) and set as active.`);
  if (activeAlias && activeAlias !== alias) {
    console.log(`  "${activeAlias}" keychain state was frozen — switch back anytime with: atc-profile use ${activeAlias}`);
  }
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
  const syncActive = options.syncActive !== false;

  const catalog = loadCatalog();
  const profile = catalog.profiles?.[alias];
  if (!profile) {
    die(`Unknown profile "${alias}". Run 'atc-profile list' to see available profiles.`);
  }

  const expectedEmail = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
  if (!expectedEmail) {
    die(`Profile "${alias}" has no email registered.\nRe-register it with: atc-profile add ${alias}`);
  }

  // switchProfile now does live validation against api/oauth/account using the
  // restored access token, so the returned authState reflects the real server-
  // side identity, not cached state from ~/.claude.json or /status.
  const { authState } = switchProfile(alias, { force: true, syncActive });
  const observedEmail = String(authState?.authStatus?.email || '').trim().toLowerCase();
  if (!observedEmail) {
    die('use failed: Claude OAuth account endpoint returned no email.');
  }

  if (observedEmail !== expectedEmail) {
    console.error(`✗ Use failed for "${alias}".`);
    console.error(`  Expected: ${expectedEmail}`);
    console.error(`  Observed: ${observedEmail}`);
    process.exit(2);
  }

  console.log(`✓ Use passed for "${alias}".`);
  console.log(`  Email: ${observedEmail}`);
  const orgName = authState?.authStatus?.orgName;
  if (orgName) {
    console.log(`  Organization: ${orgName}`);
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
  const activeToken = resolveCodexbarTokenForProfile(catalog.profiles[alias], loadCredential(alias));
  catalog.profiles[alias].codexbarToken = {
    kind: classifyClaudeCodexbarToken(activeToken) || 'unknown',
    token: activeToken,
    capturedAt: new Date().toISOString(),
  };
  catalog.profiles[alias].codexbarAccountLabel = syncCodexbarTokenAccount(alias, activeToken, {
    setActive: catalog.active === alias,
    webAuth,
  });
  catalog.profiles[alias].updatedAt = new Date().toISOString();
  saveCatalog(catalog);

  console.log(`✓ Synced Claude web token for "${alias}".`);
  console.log(`  Source: ${webAuth.source}`);
  console.log(`  sessionKey: ${maskSecret(webAuth.sessionKey)}`);
  console.log(`  Codexbar token type: ${catalog.profiles[alias].codexbarToken.kind}`);
  console.log(`  Codexbar account label: ${catalog.profiles[alias].codexbarAccountLabel}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// Parse command flags from remaining args
function parseArgs(args) {
  const result = { positional: [], yes: false, syncActive: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes') {
      result.yes = true;
    } else if (args[i] === '--sync-active') {
      result.syncActive = true;
    } else if (args[i] === '--no-sync-active') {
      result.syncActive = false;
    } else {
      result.positional.push(args[i]);
    }
  }
  return result;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

async function main() {
const [,, command, ...rest] = process.argv;
const { positional, yes: confirmYes, syncActive } = parseArgs(rest);
const arg = positional[0];
switch (command) {
  case 'add':     await cmdAdd(arg); break;
  case 'list':    cmdList(); break;
  case 'current': cmdCurrent(); break;
  case 'use':     cmdUse(arg, { syncActive }); break;
  case 'rotate':  await cmdRotate(arg); break;
  case 'remove':  cmdRemove(arg); break;
  case 'wipe':    cmdWipe(confirmYes); break;
  case 'probe-web': cmdProbeWeb(); break;
  case 'sync-web': cmdSyncWeb(arg); break;
  default:
    console.error(`atc-profile — Claude account profile manager

Commands:
  add <alias>     register the currently-logged-in account under <alias>
                  (prefer 'rotate' when you want to switch to a different account)
  rotate <alias>  guided swap: saves current keychain, clears it, waits for you
                  to run claude /login, then registers the new login as <alias>.
                  Answer 'n' at the prompt to roll back to the previous profile.
  list            show all profiles (* = active)
  current         print the active profile alias
  use <alias> [--no-sync-active] switch; refreshes OAuth if stale and validates
                  against api/oauth/account (live). --no-sync-active skips
                  backing up the currently-active profile's rotated token.
  remove <alias>  delete a profile (cannot remove the active profile)
  wipe --yes      delete Claude Keychain cred + all saved atc-profile creds/catalog
  probe-web       print detected Claude web sessionKey from Firefox cookies
  sync-web <alias> capture current Firefox Claude sessionKey into an existing profile
`);
    process.exit(command ? 1 : 0);
}
}
