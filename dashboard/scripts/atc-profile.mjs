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
import { pathToFileURL, fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { recordEvent, tailEvents, fingerprint, parseDuration, generateTraceId, filterEventsByTrace } from '../modules/credential-events.mjs';

// Ensure the credential event log lives in the same dashboard/runtime
// directory whether this script is invoked standalone or from the dashboard
// server. Skip if the caller has already pinned a dir.
if (!process.env.ATC_DASHBOARD_RUNTIME_DIR) {
  const __thisFile = fileURLToPath(import.meta.url);
  process.env.ATC_DASHBOARD_RUNTIME_DIR = path.resolve(path.dirname(__thisFile), '..', 'runtime');
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const PROFILES_DIR = path.join(os.homedir(), '.claude-profiles');
const PROFILES_JSON = path.join(PROFILES_DIR, 'profiles.json');
const BACKUP_DIR = path.join(PROFILES_DIR, '.backup');
const CODEXBAR_CONFIG = path.join(os.homedir(), '.codexbar', 'config.json');
const CLAUDE_GLOBAL_STATE = path.join(os.homedir(), '.claude.json');
const CLAUDE_OAUTH_ACCOUNT_URL = 'https://api.anthropic.com/api/oauth/account';
// Anthropic's edge fingerprints OAuth requests by client. Bare curl/* UAs get
// 429'd on /v1/oauth/token regardless of token validity. Spoofing axios got
// the refresh endpoint to return 200 — but the resulting tokens were minted
// into a degraded attribution bucket (verified empirically 2026-04-26: a
// switch immediately after our refresh showed usage=100% in Claude Code; a
// fresh login through Claude Code itself reset usage to 0%). Conclusion: we
// cannot safely mint tokens outside Claude Code. The fix is structural — we
// no longer call /v1/oauth/token at all. Claude Code refreshes through its
// own allowlisted path; we only ever read identity from /api/oauth/account
// using whatever AT is currently in the keychain. Headers below stay matched
// to upstream because the identity endpoint shares the same edge fingerprint.
const CLAUDE_OAUTH_USER_AGENT = 'axios/1.7.7';
const CLAUDE_OAUTH_ACCEPT = 'application/json, text/plain, */*';
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

function setRotateLock(catalog, { rotateId, fromAlias, toAlias }) {
  catalog.rotation = {
    inProgress: true,
    rotateId,
    fromAlias: fromAlias || null,
    toAlias: toAlias || null,
    startedAt: new Date().toISOString(),
  };
  saveCatalog(catalog);
  recordEvent({
    actor: 'rotate',
    action: 'rotate-lock-set',
    rotate_id: rotateId,
    from_alias: fromAlias || null,
    to_alias: toAlias || null,
    outcome: 'ok',
  });
}

function clearRotateLock(catalog, rotateId, outcome = 'ok') {
  if (!catalog?.rotation?.inProgress) return;
  if (rotateId && catalog.rotation.rotateId && catalog.rotation.rotateId !== rotateId) return;
  delete catalog.rotation;
  saveCatalog(catalog);
  recordEvent({
    actor: 'rotate',
    action: 'rotate-lock-clear',
    rotate_id: rotateId || null,
    outcome,
  });
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
      '-H', `Accept: ${CLAUDE_OAUTH_ACCEPT}`,
      '-H', `User-Agent: ${CLAUDE_OAUTH_USER_AGENT}`,
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

function keychainDelete({ actor = 'atc-profile', reason = null, traceId = null } = {}) {
  let existed = true;
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s', KEYCHAIN_SERVICE,
    ], { stdio: 'ignore' });
  } catch {
    existed = false;
  }
  recordEvent({
    actor,
    action: 'keychain-delete',
    outcome: existed ? 'ok' : 'skipped:not-present',
    reason,
    trace_id: traceId,
  });
}

function keychainImport(blob, { actor = 'atc-profile', alias = null, reason = null, traceId = null } = {}) {
  const parsed = parseCredentialBlob(blob);
  const eventBase = {
    actor,
    action: 'keychain-write',
    alias,
    rt_fp: fingerprint(parsed?.claudeAiOauth?.refreshToken),
    at_fp: fingerprint(parsed?.claudeAiOauth?.accessToken),
    expires_at: parsed?.claudeAiOauth?.expiresAt ? new Date(parsed.claudeAiOauth.expiresAt).toISOString() : null,
    reason,
    trace_id: traceId,
  };
  try {
    execFileSync('security', [
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', os.userInfo().username,
      '-w', blob,
      '-U',           // update if already exists (atomic replace; preserves prior credential on failure)
      '-A',           // no per-app ACL gate. Without this the new entry trusts
                      // only `security`, so the `claude` binary can't decrypt
                      // it from a non-GUI context (ttyd-managed tmux sessions,
                      // launchd-spawned children) — there's no UI to answer
                      // the keychain prompt, the read fails, and claude shows
                      // "not logged in" even though the entry exists. -A only
                      // takes effect when the entry is freshly created; -U on
                      // an existing entry preserves the old ACL.
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const stderr = (err.stderr ? err.stderr.toString() : '').trim();
    const detail = stderr || err.message || 'security add-generic-password failed';
    recordEvent({ ...eventBase, outcome: `error:${err.status ?? 'spawn'}`, detail });
    const hint = /interaction is not allowed|user interaction is not allowed|errSecInteractionNotAllowed/i.test(detail)
      ? '\nThe login keychain is locked. Unlock the Mac (or run `security unlock-keychain`) and retry.'
      : '';
    const e = new Error(`security add-generic-password failed: ${detail}${hint}`);
    e.securityStderr = stderr;
    throw e;
  }
  recordEvent({ ...eventBase, outcome: 'ok' });
}

// ── profile credential files ─────────────────────────────────────────────────

function credPath(alias) {
  return path.join(PROFILES_DIR, `${alias}.cred`);
}

function saveCredential(alias, blob, { actor = 'atc-profile', reason = null, source = null, traceId = null } = {}) {
  ensureDir(PROFILES_DIR);
  const parsed = parseCredentialBlob(blob);
  const p = credPath(alias);
  // Capture what's on disk BEFORE we overwrite — we want to know if we're
  // trampling a newer RT that some other flow put there.
  let prevRtFp = null;
  let prevAtFp = null;
  let prevMtime = null;
  try {
    const st = fs.statSync(p);
    prevMtime = new Date(st.mtimeMs).toISOString();
    const existing = fs.readFileSync(p, 'utf8').trim();
    const prevParsed = parseCredentialBlob(existing);
    prevRtFp = fingerprint(prevParsed?.claudeAiOauth?.refreshToken);
    prevAtFp = fingerprint(prevParsed?.claudeAiOauth?.accessToken);
  } catch { /* no prior file — fine */ }

  fs.writeFileSync(p, blob, { encoding: 'utf8', mode: 0o600 });
  const newRtFp = fingerprint(parsed?.claudeAiOauth?.refreshToken);
  const newAtFp = fingerprint(parsed?.claudeAiOauth?.accessToken);
  recordEvent({
    actor,
    action: 'disk-write',
    alias,
    rt_fp: newRtFp,
    at_fp: newAtFp,
    prev_rt_fp: prevRtFp,
    prev_at_fp: prevAtFp,
    prev_mtime: prevMtime,
    rt_changed: prevRtFp ? prevRtFp !== newRtFp : null,
    expires_at: parsed?.claudeAiOauth?.expiresAt ? new Date(parsed.claudeAiOauth.expiresAt).toISOString() : null,
    scopes: Array.isArray(parsed?.claudeAiOauth?.scopes) ? parsed.claudeAiOauth.scopes : null,
    size: Buffer.byteLength(blob, 'utf8'),
    outcome: 'ok',
    reason,
    source,
    trace_id: traceId,
  });
}

function loadCredential(alias, { actor = 'atc-profile', reason = null, traceId = null } = {}) {
  const p = credPath(alias);
  if (!fs.existsSync(p)) {
    recordEvent({ actor, action: 'disk-read', alias, outcome: 'missing', reason, trace_id: traceId });
    throw new Error(`No saved credential for profile "${alias}" at ${p}`);
  }
  const blob = fs.readFileSync(p, 'utf8').trim();
  let rtFp = null;
  let atFp = null;
  let expiresAt = null;
  let mtime = null;
  try {
    const parsed = parseCredentialBlob(blob);
    rtFp = fingerprint(parsed?.claudeAiOauth?.refreshToken);
    atFp = fingerprint(parsed?.claudeAiOauth?.accessToken);
    expiresAt = parsed?.claudeAiOauth?.expiresAt
      ? new Date(parsed.claudeAiOauth.expiresAt).toISOString()
      : null;
  } catch { /* parse errors logged as outcome */ }
  try {
    mtime = new Date(fs.statSync(p).mtimeMs).toISOString();
  } catch { /* ignore */ }
  recordEvent({
    actor,
    action: 'disk-read',
    alias,
    rt_fp: rtFp,
    at_fp: atFp,
    expires_at: expiresAt,
    mtime,
    size: Buffer.byteLength(blob, 'utf8'),
    outcome: 'ok',
    reason,
    trace_id: traceId,
  });
  return blob;
}

function backupCurrent(blob, { actor = 'atc-profile', alias = null, traceId = null } = {}) {
  ensureDir(BACKUP_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `${ts}.cred`);
  fs.writeFileSync(file, blob, { encoding: 'utf8', mode: 0o600 });
  const parsed = parseCredentialBlob(blob);
  recordEvent({
    actor,
    action: 'backup-write',
    alias,
    rt_fp: fingerprint(parsed?.claudeAiOauth?.refreshToken),
    outcome: 'ok',
    file: path.basename(file),
    trace_id: traceId,
  });
}

// ── commands ──────────────────────────────────────────────────────────────────

async function cmdAdd(alias) {
  if (!alias || !/^[a-z0-9_-]+$/i.test(alias)) {
    die('Usage: atc-profile add <alias>');
  }

  const traceId = generateTraceId();
  const catalog = loadCatalog();
  const existingProfile = catalog.profiles[alias] || null;
  recordEvent({
    actor: 'add',
    action: 'add-start',
    alias,
    trace_id: traceId,
    existing: !!existingProfile,
    outcome: 'started',
  });

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

  // Account UUID is a stable, server-assigned identifier. Emails can be
  // reused across accounts (rare but possible) — UUIDs cannot. Pinning here
  // turns our identity guarantee from a soft "string match" into a hard
  // "server-issued GUID match" every future read can verify against.
  const observedAccountUuid = typeof authState?.oauthAccount?.accountUuid === 'string' && authState.oauthAccount.accountUuid.trim()
    ? authState.oauthAccount.accountUuid.trim()
    : null;

  // Existing alias can be refreshed in-place, but do not silently rebind to a
  // different account. Check UUID first (hard), fall back to email (soft) for
  // existing profiles from before UUID pinning was introduced.
  if (existingProfile) {
    const pinnedUuid = typeof existingProfile.accountUuid === 'string' ? existingProfile.accountUuid.trim() : '';
    const existingEmail = String(existingProfile.email || '').trim().toLowerCase();
    if (pinnedUuid && observedAccountUuid && pinnedUuid !== observedAccountUuid) {
      recordEvent({
        actor: 'add',
        action: 'identity-pin-broken',
        alias,
        trace_id: traceId,
        pinned_uuid: pinnedUuid,
        observed_uuid: observedAccountUuid,
        outcome: 'add-rejected',
      });
      die(
        `Profile "${alias}" is pinned to account UUID ${pinnedUuid}, but current login is UUID ${observedAccountUuid}.\n` +
        `Use a different alias, or remove "${alias}" first to rebind it.`
      );
    }
    if (!pinnedUuid && existingEmail && existingEmail !== normalizedEmail) {
      die(
        `Profile "${alias}" is bound to ${existingEmail}, but current login is ${normalizedEmail}.\n` +
        `Use a different alias, or remove "${alias}" first to rebind it.`
      );
    }
  }

  saveCredential(alias, blob, { actor: 'add', reason: existingProfile ? 'refresh-alias' : 'register', source: 'keychain-export', traceId });
  const codexbarAccountLabel = syncCodexbarTokenAccount(alias, codexbarToken, { setActive: true, webAuth });

  catalog.profiles[alias] = {
    ...(existingProfile && typeof existingProfile === 'object' ? existingProfile : {}),
    displayName: alias,
    ...(normalizedEmail ? { email: normalizedEmail } : {}),
    ...(observedAccountUuid ? {
      accountUuid: observedAccountUuid,
      accountUuidPinnedAt: existingProfile?.accountUuid === observedAccountUuid
        ? (existingProfile.accountUuidPinnedAt || new Date().toISOString())
        : new Date().toISOString(),
    } : {}),
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
  if (observedAccountUuid && (!existingProfile?.accountUuid || existingProfile.accountUuid !== observedAccountUuid)) {
    recordEvent({
      actor: 'add',
      action: 'identity-pin-set',
      alias,
      trace_id: traceId,
      account_uuid: observedAccountUuid,
      observed_email: normalizedEmail,
      previous_uuid: existingProfile?.accountUuid || null,
      outcome: 'ok',
    });
  }
  // `add` represents "register what I am currently logged into right now".
  // Make the newly added profile active immediately to match CLI + web state.
  catalog.active = alias;
  applyClaudeGlobalAuthState(authState);
  saveCatalog(catalog);

  recordEvent({
    actor: 'add',
    action: 'add-complete',
    alias,
    trace_id: traceId,
    observed_email: normalizedEmail,
    outcome: 'ok',
    set_active: true,
    existing: !!existingProfile,
  });

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

export function validateAliasIdentity(expectedEmail, observedEmail) {
  const expected = typeof expectedEmail === 'string' ? expectedEmail.trim().toLowerCase() : '';
  const observed = typeof observedEmail === 'string' ? observedEmail.trim().toLowerCase() : '';
  if (!expected) return { ok: true, reason: 'no-expected-email' };
  if (!observed) return { ok: false, reason: 'unverified' };
  if (observed !== expected) return { ok: false, reason: 'mismatch' };
  return { ok: true, reason: 'match' };
}

// Extract the account email embedded in a credential blob. Claude Code writes
// it into claudeAiOauth.emailAddress at login; some older blobs use `email`.
// Returns a lowercased trimmed string, or null when absent/malformed.
export function readCredentialBlobEmail(blob) {
  const parsed = parseCredentialBlob(blob);
  const raw = parsed?.claudeAiOauth?.emailAddress || parsed?.claudeAiOauth?.email || null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed || null;
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

  const switchId = randomUUID();
  const fromAlias = catalog.active || null;
  recordEvent({
    actor: 'switch',
    action: 'switch-start',
    alias,
    from_alias: fromAlias,
    switch_id: switchId,
    sync_active: syncActive,
    outcome: 'started',
  });

  // NOTE: sync-active used to run here, at the top of switchProfile. It has
  // been moved down to just before the keychain swap so we capture the
  // outgoing keychain as close as possible to the swap — narrowing the window
  // in which another Claude process could rotate the RT between capture and
  // swap.

  // 1. Load the target credential. Snapshots can drift if Claude Code rotated
  //    the RT after our last sync; if so, the AT in the blob may already be
  //    dead. We do NOT refresh ourselves — that path mints tokens with a
  //    degraded usage attribution at Anthropic's edge (see CLAUDE_OAUTH_USER_AGENT
  //    header comment). Instead: install whatever the blob contains and let
  //    Claude Code refresh through its own allowlisted path on first call.
  let targetBlob = loadCredential(alias, { actor: 'switch', reason: 'load-target' });

  const targetProfile = catalog.profiles[alias];
  const targetExpectedEmail = typeof targetProfile?.email === 'string'
    ? targetProfile.email.trim().toLowerCase()
    : '';

  // Byte-level identity guard: if the blob's embedded email disagrees with
  // the alias's expected email, the file on disk is corrupted. Abort before
  // any keychain or disk write.
  if (targetExpectedEmail) {
    const targetBlobEmail = readCredentialBlobEmail(targetBlob);
    if (targetBlobEmail && targetBlobEmail !== targetExpectedEmail) {
      recordEvent({
        actor: 'switch',
        action: 'switch-abort',
        alias,
        switch_id: switchId,
        expected_email: targetExpectedEmail,
        observed_email: targetBlobEmail,
        outcome: 'blob-identity-mismatch',
      });
      die(
        `Refusing switch: ${alias}.cred is bound to ${targetExpectedEmail}, but the blob on disk holds credentials for ${targetBlobEmail}.\n` +
        `This file is corrupted (likely from a prior sync race). No keychain or disk writes were attempted.\n` +
        `Recover with: atc-profile rotate ${alias}`
      );
    }
  }

  // 2. Best-effort live identity check using the AT in the blob. If the AT
  //    is fresh enough to round-trip, we get a live email + UUID and can do
  //    the strong UUID-pin gate. If the AT is stale (401/403), we skip the
  //    live check and trust the byte-level email guard above + the cached
  //    UUID pin. Claude Code will refresh after the swap.
  let authState = null;
  let liveIdentityVerified = false;
  try {
    authState = fetchClaudeAccountStateFromBlob(targetBlob);
    liveIdentityVerified = true;
  } catch (error) {
    const unauthorized = error?.httpStatus === 401 || error?.httpStatus === 403;
    if (!unauthorized) {
      recordEvent({
        actor: 'switch',
        action: 'identity-check',
        alias,
        switch_id: switchId,
        http_status: error?.httpStatus || null,
        outcome: `error:${error?.httpStatus || 'network'}`,
        detail: error?.message || null,
      });
      die(
        `Could not verify identity for "${alias}": ${error.message}\n` +
        `Recovery:\n` +
        `  1) check network connectivity\n` +
        `  2) re-login: atc-profile rotate ${alias}`
      );
    }
    recordEvent({
      actor: 'switch',
      action: 'identity-check',
      alias,
      switch_id: switchId,
      http_status: error?.httpStatus || null,
      outcome: 'stale-at-fallthrough',
      detail: 'AT stale; relying on byte-level identity + cached UUID pin',
    });
    console.warn(`  Note: stale access token for "${alias}". Skipping live identity check; trusting blob email and pinned UUID. Claude Code will refresh on next call.`);
  }

  const targetObservedEmail = liveIdentityVerified
    ? String(authState?.authStatus?.email || '').trim().toLowerCase()
    : '';
  const targetObservedUuid = liveIdentityVerified && typeof authState?.oauthAccount?.accountUuid === 'string'
    ? authState.oauthAccount.accountUuid.trim()
    : '';
  const targetPinnedUuid = typeof targetProfile?.accountUuid === 'string'
    ? targetProfile.accountUuid.trim()
    : '';

  // UUID check is the HARD identity gate when we have a live response. A
  // mismatch is proof of contamination. With a stale AT we can't observe a
  // UUID, so we trust the cached pin (set at registration via a successful
  // live check; only invalidated by re-login through `add`/`rotate`).
  if (liveIdentityVerified && targetPinnedUuid) {
    if (!targetObservedUuid) {
      recordEvent({
        actor: 'switch',
        action: 'switch-abort',
        alias,
        switch_id: switchId,
        pinned_uuid: targetPinnedUuid,
        observed_uuid: null,
        outcome: 'target-uuid-unverified',
      });
      die(
        `Refusing switch: profile "${alias}" is pinned to UUID ${targetPinnedUuid}, but /account did not return a UUID.\n` +
        `No keychain or catalog changes were applied.\n` +
        `Recovery: atc-profile rotate ${alias}`
      );
    }
    if (targetObservedUuid !== targetPinnedUuid) {
      recordEvent({
        actor: 'switch',
        action: 'switch-abort',
        alias,
        switch_id: switchId,
        pinned_uuid: targetPinnedUuid,
        observed_uuid: targetObservedUuid,
        observed_email: targetObservedEmail,
        expected_email: targetExpectedEmail,
        outcome: 'target-uuid-mismatch',
      });
      die(
        `Refusing switch: profile "${alias}" is pinned to UUID ${targetPinnedUuid}, but loaded credential is UUID ${targetObservedUuid}.\n` +
        `This is proof of credential contamination. No keychain or catalog changes were applied.\n` +
        `Recovery: atc-profile rotate ${alias}`
      );
    }
  }

  if (liveIdentityVerified) {
    const targetIdentity = validateAliasIdentity(targetExpectedEmail, targetObservedEmail);
    if (!targetIdentity.ok && targetIdentity.reason === 'mismatch') {
      recordEvent({
        actor: 'switch',
        action: 'switch-abort',
        alias,
        switch_id: switchId,
        expected_email: targetExpectedEmail,
        observed_email: targetObservedEmail,
        outcome: 'target-identity-mismatch',
      });
      die(
        `Refusing switch: profile "${alias}" is bound to ${targetExpectedEmail}, but loaded credential is ${targetObservedEmail}.\n` +
        `No keychain or catalog changes were applied.\n` +
        `Recovery: atc-profile rotate ${alias}`
      );
    }
    if (!targetIdentity.ok && targetIdentity.reason === 'unverified') {
      recordEvent({
        actor: 'switch',
        action: 'switch-abort',
        alias,
        switch_id: switchId,
        expected_email: targetExpectedEmail,
        observed_email: null,
        outcome: 'target-identity-unverified',
      });
      die(
        `Refusing switch: could not verify identity for profile "${alias}" before swap.\n` +
        `No keychain or catalog changes were applied.\n` +
        `Recovery: atc-profile rotate ${alias}`
      );
    }
  }

  const profile = catalog.profiles[alias];
  if (profile && liveIdentityVerified) {
    profile.authState = authState;
    if (!profile.email && authState?.authStatus?.email) {
      profile.email = authState.authStatus.email;
    }
    // Opportunistic UUID pin backfill for profiles that predate UUID pinning.
    if (!profile.accountUuid && targetObservedUuid) {
      profile.accountUuid = targetObservedUuid;
      profile.accountUuidPinnedAt = new Date().toISOString();
      recordEvent({
        actor: 'switch',
        action: 'identity-pin-set',
        alias,
        switch_id: switchId,
        account_uuid: targetObservedUuid,
        observed_email: targetObservedEmail,
        reason: 'backfill-on-switch',
        outcome: 'ok',
      });
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
      backupCurrent(currentBlob, { actor: 'switch', alias: catalog.active });
    } catch {
      // Keychain empty (e.g. user already ran /logout) — nothing to save.
    }

    if (currentBlob) {
      const activeProfile = catalog.profiles[catalog.active];
      const expectedEmail = typeof activeProfile?.email === 'string'
        ? activeProfile.email.trim().toLowerCase()
        : '';

      if (expectedEmail) {
        let observedEmail = null;
        let observedUuid = null;
        const pinnedUuid = typeof activeProfile?.accountUuid === 'string' ? activeProfile.accountUuid.trim() : '';
        try {
          const activeAuthState = fetchClaudeAccountStateFromBlob(currentBlob);
          observedEmail = String(activeAuthState?.authStatus?.email || '').trim().toLowerCase();
          observedUuid = typeof activeAuthState?.oauthAccount?.accountUuid === 'string'
            ? activeAuthState.oauthAccount.accountUuid.trim()
            : null;
          const uuidVerdict = pinnedUuid
            ? (observedUuid === pinnedUuid ? 'uuid-match' : 'uuid-mismatch')
            : null;
          const emailVerdict = observedEmail === expectedEmail ? 'match' : 'mismatch';
          recordEvent({
            actor: 'switch',
            action: 'identity-check',
            alias: catalog.active,
            switch_id: switchId,
            expected_email: expectedEmail,
            observed_email: observedEmail,
            pinned_uuid: pinnedUuid || null,
            observed_uuid: observedUuid,
            outcome: uuidVerdict || emailVerdict,
          });
          if (uuidVerdict === 'uuid-mismatch') {
            recordEvent({
              actor: 'switch',
              action: 'identity-pin-broken',
              alias: catalog.active,
              switch_id: switchId,
              pinned_uuid: pinnedUuid,
              observed_uuid: observedUuid,
              outcome: 'sync-active-skipped',
            });
          }
        } catch (error) {
          recordEvent({ actor: 'switch', action: 'identity-check', alias: catalog.active, outcome: `error:${error?.httpStatus || 'unknown'}`, detail: error.message });
          console.warn(`  Warning: could not verify keychain identity for "${catalog.active}": ${error.message}`);
          console.warn(`  Skipping cred save to avoid drift risk.`);
        }

        // Hard gate: if a pin exists, UUID must match. Email match alone is
        // not enough — email can be re-used across accounts, UUID cannot.
        const uuidGateOk = pinnedUuid ? (observedUuid && observedUuid === pinnedUuid) : true;
        if (uuidGateOk && observedEmail && observedEmail === expectedEmail) {
          saveCredential(catalog.active, currentBlob, { actor: 'switch', reason: 'sync-active-save', source: 'keychain-export', traceId: switchId });
          if (activeProfile) {
            activeProfile.updatedAt = new Date().toISOString();
            // Opportunistic pin backfill on the outgoing side.
            if (!activeProfile.accountUuid && observedUuid) {
              activeProfile.accountUuid = observedUuid;
              activeProfile.accountUuidPinnedAt = new Date().toISOString();
            }
          }
        } else if (!uuidGateOk) {
          console.warn(`  Warning: Keychain UUID ${observedUuid} does not match pinned UUID ${pinnedUuid} for "${catalog.active}".`);
          console.warn(`  Skipping cred save to avoid contamination.`);
        } else if (observedEmail && observedEmail !== expectedEmail) {
          console.warn(`  Warning: Keychain holds ${observedEmail}, but active profile "${catalog.active}" is bound to ${expectedEmail}.`);
          console.warn(`  Skipping cred save to avoid clobbering with wrong account's credentials.`);
        }
      } else {
        // Legacy profile with no recorded email — save without identity check
        // to preserve the pre-fix-#2 behavior.
        saveCredential(catalog.active, currentBlob, { actor: 'switch', reason: 'sync-active-legacy', source: 'keychain-export' });
        if (activeProfile) {
          activeProfile.updatedAt = new Date().toISOString();
        }
      }
    }
  }

  // 3. Swap Keychain entry. We write with -U (atomic update-in-place) instead
  //    of delete-then-add, because the latter is non-atomic: if the add fails
  //    after the delete (e.g. the login keychain is locked because the Mac is
  //    asleep), the keychain is left empty and Claude Code will demand /login.
  //    With -U, a failed write preserves the previous credential and the swap
  //    is fully recoverable.
  try {
    keychainImport(targetBlob, { actor: 'switch', alias, reason: 'final-swap', traceId: switchId });
  } catch (error) {
    recordEvent({
      actor: 'switch',
      action: 'switch-abort',
      alias,
      switch_id: switchId,
      outcome: 'keychain-write-failed',
      detail: error.message,
    });
    die(
      `Switch to "${alias}" aborted: could not write credential to keychain.\n` +
      `${error.message}\n` +
      `The previous credential is still in place; no Claude sessions were disturbed.`
    );
  }
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

  recordEvent({
    actor: 'switch',
    action: 'switch-complete',
    alias,
    from_alias: fromAlias,
    switch_id: switchId,
    live_identity_verified: liveIdentityVerified,
    observed_email: authState?.authStatus?.email || null,
    outcome: 'ok',
  });
  console.log(`✓ Switched to profile "${alias}".${liveIdentityVerified ? '' : ' (live identity check skipped — AT stale; Claude Code will refresh on first call)'}`);
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
  const preParsed = parseCredentialBlob(blob);
  const preRtFp = fingerprint(preParsed?.claudeAiOauth?.refreshToken);
  recordEvent({
    actor: 'rotate',
    action: 'freeze-start',
    alias: activeAlias,
    expected_email: expectedEmail || null,
    pre_rt_fp: preRtFp,
    pre_expires_at: preParsed?.claudeAiOauth?.expiresAt
      ? new Date(preParsed.claudeAiOauth.expiresAt).toISOString()
      : null,
    outcome: 'started',
  });

  // Best-effort live identity check. If the AT in the keychain is stale we
  // cannot refresh ourselves (see CLAUDE_OAUTH_USER_AGENT comment). Fall back
  // to the byte-level email embedded in the blob — the strong identity guard
  // happens at registration time via UUID pin; this is a freeze-time sanity
  // check to avoid clobbering with the wrong account's credentials.
  let authState = null;
  let observedEmail = null;
  let subscriptionType = null;
  let identityHttpStatus = null;
  let identityError = null;
  try {
    authState = fetchClaudeAccountStateFromBlob(blob);
    observedEmail = String(authState?.authStatus?.email || '').trim().toLowerCase();
    subscriptionType = String(authState?.authStatus?.subscriptionType || authState?.subscriptionType || '').trim() || null;
  } catch (error) {
    identityHttpStatus = error?.httpStatus || null;
    identityError = error?.message || String(error);
  }
  const blobEmail = readCredentialBlobEmail(blob);
  const effectiveEmail = observedEmail || blobEmail || null;
  const identityOutcome = identityError
    ? `error:${identityHttpStatus || 'unknown'}`
    : (expectedEmail && observedEmail && observedEmail !== expectedEmail ? 'mismatch' : (observedEmail ? 'match' : 'unverified'));
  recordEvent({
    actor: 'rotate',
    action: 'identity-check',
    alias: activeAlias,
    expected_email: expectedEmail || null,
    observed_email: observedEmail || null,
    blob_email: blobEmail || null,
    subscription_type: subscriptionType,
    http_status: identityHttpStatus,
    phase: 'pre-freeze-save',
    outcome: identityOutcome,
    detail: identityError,
  });

  if (expectedEmail && effectiveEmail && effectiveEmail !== expectedEmail) {
    console.error(`✗ Keychain holds ${effectiveEmail}, not the expected ${expectedEmail} for active profile "${activeAlias}".`);
    console.error(`  Aborting to avoid clobbering ${activeAlias}.cred with the wrong account's credentials.`);
    console.error(`  To register the current login, run: atc-profile add <alias>`);
    process.exit(1);
  }
  if (expectedEmail && !effectiveEmail) {
    console.warn(`  Warning: could not verify keychain identity (live: ${identityHttpStatus || 'error'}, blob: missing); skipping cred save for "${activeAlias}".`);
    return null;
  }

  if (expectedEmail || allowLegacy) {
    backupCurrent(blob, { actor: 'rotate', alias: activeAlias });
    saveCredential(activeAlias, blob, {
      actor: 'rotate',
      reason: expectedEmail ? 'freeze-save' : 'freeze-save-legacy',
      source: 'keychain-export',
    });
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
  const rotateId = randomUUID();
  recordEvent({
    actor: 'rotate',
    action: 'rotate-start',
    alias,
    from_alias: activeAlias,
    rotate_id: rotateId,
    outcome: 'started',
  });

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

  // Prevent background sync from writing keychain state into the outgoing alias
  // while rotate is in the login window.
  setRotateLock(catalog, { rotateId, fromAlias: activeAlias, toAlias: alias });

  // Phase 1b — clear keychain so no running claude process can consume the RT
  keychainDelete({ actor: 'rotate', reason: 'pre-login-clear' });
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
        keychainImport(savedBlob, { actor: 'rotate', alias: activeAlias, reason: 'rollback' });
        console.log(`✓ Restored keychain to "${activeAlias}" — nothing changed.`);
        clearRotateLock(catalog, rotateId, 'rollback');
        return;
      } catch (error) {
        clearRotateLock(catalog, rotateId, 'rollback-failed');
        console.error(`✗ Could not restore keychain: ${error.message}`);
        console.error(`  ${activeAlias}.cred is intact — recover with: atc-profile use ${activeAlias}`);
        process.exit(1);
      }
    }
    clearRotateLock(catalog, rotateId, 'cancelled');
    console.log('  Keychain remains empty. Nothing to roll back.');
    return;
  }

  // Phase 3 — read & validate new keychain credential
  let newBlob;
  try {
    newBlob = keychainExport();
  } catch {
    clearRotateLock(catalog, rotateId, 'post-login-empty');
    console.error('✗ Keychain is still empty — claude /login did not complete.');
    if (activeAlias) {
      console.error(`  To restore "${activeAlias}", run: atc-profile use ${activeAlias}`);
    }
    process.exit(1);
  }

  let newAuthState;
  try {
    newAuthState = fetchClaudeAccountStateFromBlob(newBlob);
  } catch (error) {
    clearRotateLock(catalog, rotateId, 'post-login-identity-error');
    throw error;
  }
  const observedEmail = typeof newAuthState?.authStatus?.email === 'string'
    ? newAuthState.authStatus.email.trim().toLowerCase()
    : null;
  if (!observedEmail) {
    clearRotateLock(catalog, rotateId, 'post-login-email-missing');
    die('Could not determine logged-in email from Claude OAuth account metadata.');
  }

  // Guard: refuse if this email is already registered under a different alias
  for (const [otherAlias, otherProfile] of Object.entries(catalog.profiles || {})) {
    if (otherAlias === alias) continue;
    const otherEmail = String(otherProfile?.email || '').trim().toLowerCase();
    if (otherEmail && otherEmail === observedEmail) {
      clearRotateLock(catalog, rotateId, 'duplicate-email');
      console.error(`✗ Email ${observedEmail} is already registered as profile "${otherAlias}".`);
      console.error(`  Use a different alias, or remove "${otherAlias}" first.`);
      process.exit(1);
    }
  }

  const observedUuid = typeof newAuthState?.oauthAccount?.accountUuid === 'string'
    ? newAuthState.oauthAccount.accountUuid.trim()
    : null;

  // Guard: refuse if re-registering <alias> under a different account than
  // its existing pin. UUID takes precedence; email is a soft fallback for
  // profiles that predate UUID pinning.
  const existingProfile = catalog.profiles?.[alias] || null;
  if (existingProfile) {
    const pinnedUuid = typeof existingProfile.accountUuid === 'string' ? existingProfile.accountUuid.trim() : '';
    const existingEmail = String(existingProfile.email || '').trim().toLowerCase();
    if (pinnedUuid && observedUuid && pinnedUuid !== observedUuid) {
      clearRotateLock(catalog, rotateId, 'alias-rebind-uuid-mismatch');
      recordEvent({
        actor: 'rotate',
        action: 'identity-pin-broken',
        alias,
        rotate_id: rotateId,
        pinned_uuid: pinnedUuid,
        observed_uuid: observedUuid,
        outcome: 'rotate-rejected',
      });
      console.error(`✗ Profile "${alias}" is pinned to UUID ${pinnedUuid}, but new login is UUID ${observedUuid}.`);
      console.error(`  Use a different alias, or remove "${alias}" first to rebind it.`);
      process.exit(1);
    }
    if (!pinnedUuid && existingEmail && existingEmail !== observedEmail) {
      clearRotateLock(catalog, rotateId, 'alias-rebind-mismatch');
      console.error(`✗ Profile "${alias}" is bound to ${existingEmail}, but new login is ${observedEmail}.`);
      console.error(`  Use a different alias, or remove "${alias}" first to rebind it.`);
      process.exit(1);
    }
  }

  // Phase 4 — register
  const webAuth = captureClaudeWebAuth();
  const oauthAccessToken = extractClaudeOauthAccessToken(newBlob);
  const codexbarToken = oauthAccessToken || webAuth.sessionKey;

  saveCredential(alias, newBlob, { actor: 'rotate', reason: existingProfile ? 're-register' : 'register', source: 'keychain-export-post-login', traceId: rotateId });
  const codexbarAccountLabel = syncCodexbarTokenAccount(alias, codexbarToken, { setActive: true, webAuth });

  catalog.profiles[alias] = {
    ...(existingProfile && typeof existingProfile === 'object' ? existingProfile : {}),
    displayName: alias,
    email: observedEmail,
    ...(observedUuid ? {
      accountUuid: observedUuid,
      accountUuidPinnedAt: existingProfile?.accountUuid === observedUuid
        ? (existingProfile.accountUuidPinnedAt || new Date().toISOString())
        : new Date().toISOString(),
    } : {}),
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
  clearRotateLock(catalog, rotateId, 'ok');

  if (observedUuid && (!existingProfile?.accountUuid || existingProfile.accountUuid !== observedUuid)) {
    recordEvent({
      actor: 'rotate',
      action: 'identity-pin-set',
      alias,
      rotate_id: rotateId,
      account_uuid: observedUuid,
      observed_email: observedEmail,
      previous_uuid: existingProfile?.accountUuid || null,
      outcome: 'ok',
    });
  }
  recordEvent({
    actor: 'rotate',
    action: 'rotate-complete',
    alias,
    from_alias: activeAlias,
    rotate_id: rotateId,
    observed_email: observedEmail,
    observed_uuid: observedUuid,
    re_registered: !!existingProfile,
    outcome: 'ok',
  });
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
  const activeToken = resolveCodexbarTokenForProfile(catalog.profiles[alias], loadCredential(alias, { actor: 'sync-web', reason: 'read-for-codexbar-token' }));
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

function cmdLog({ alias = null, sinceArg = null, limit = 50, json = false } = {}) {
  const sinceMs = sinceArg ? Date.now() - parseDuration(sinceArg) : null;
  const events = tailEvents({ alias, sinceMs, limit });
  if (events.length === 0) {
    console.log(alias ? `(no events for "${alias}")` : '(no events)');
    return;
  }
  if (json) {
    for (const e of events) console.log(JSON.stringify(e));
    return;
  }
  for (const e of events) {
    const parts = [e.ts, `[${e.actor}]`, e.action];
    if (e.alias) parts.push(`alias=${e.alias}`);
    if (e.phase) parts.push(`phase=${e.phase}`);
    if (e.http_status) parts.push(`http=${e.http_status}`);
    if (e.oauth_error) parts.push(`oauth_error=${e.oauth_error}`);
    if (e.rt_fp) parts.push(`rt=${e.rt_fp}`);
    if (e.observed_email) parts.push(`email=${e.observed_email}`);
    if (e.trigger) parts.push(`trigger=${e.trigger}`);
    parts.push(`outcome=${e.outcome}`);
    if (e.detail) parts.push(`(${String(e.detail).slice(0, 120)})`);
    console.log(parts.join(' '));
  }
}

// diagnose <trace-id> — print every event that belongs to a single operation,
// matched by trace_id / switch_id / rotate_id / add_id. The event log already
// keeps enough detail that one grep by trace_id reconstructs the full story;
// this command just does the grep + pretty-prints.
function cmdDiagnose(traceId, { json = false, includeRotated = false } = {}) {
  const id = String(traceId || '').trim();
  if (!id) die('Usage: atc-profile diagnose <trace-id>');
  // Pull a wide window — diagnose is a post-mortem tool, accept some slowness.
  const events = tailEvents({ limit: 100_000, includeRotated });
  const matches = filterEventsByTrace(events, id);
  if (matches.length === 0) {
    console.log(`No events found for trace "${id}".`);
    console.log('Try: atc-profile log --limit 200 | grep <id-fragment>  to discover available IDs.');
    return;
  }
  if (json) {
    for (const e of matches) console.log(JSON.stringify(e));
    return;
  }
  console.log(`Trace ${id} — ${matches.length} events:\n`);
  const firstTs = Date.parse(matches[0].ts);
  for (const e of matches) {
    const deltaMs = Date.parse(e.ts) - firstTs;
    const parts = [`+${String(deltaMs).padStart(5)}ms`, `[${e.actor}]`, e.action];
    if (e.alias) parts.push(`alias=${e.alias}`);
    if (e.phase) parts.push(`phase=${e.phase}`);
    if (e.http_status) parts.push(`http=${e.http_status}`);
    if (e.oauth_error) parts.push(`oauth_error=${e.oauth_error}`);
    if (e.rt_fp) parts.push(`rt=${e.rt_fp}`);
    if (e.observed_email) parts.push(`email=${e.observed_email}`);
    if (e.expected_email && e.observed_email !== e.expected_email) parts.push(`expected=${e.expected_email}`);
    if (e.trigger) parts.push(`trigger=${e.trigger}`);
    parts.push(`outcome=${e.outcome}`);
    if (e.detail) parts.push(`(${String(e.detail).slice(0, 120)})`);
    console.log(parts.join(' '));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// Parse command flags from remaining args
function parseArgs(args) {
  const result = { positional: [], yes: false, syncActive: true, alias: null, since: null, limit: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yes') {
      result.yes = true;
    } else if (arg === '--sync-active') {
      result.syncActive = true;
    } else if (arg === '--no-sync-active') {
      result.syncActive = false;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--alias' && i + 1 < args.length) {
      result.alias = args[++i];
    } else if (arg.startsWith('--alias=')) {
      result.alias = arg.slice('--alias='.length);
    } else if (arg === '--since' && i + 1 < args.length) {
      result.since = args[++i];
    } else if (arg.startsWith('--since=')) {
      result.since = arg.slice('--since='.length);
    } else if (arg === '--limit' && i + 1 < args.length) {
      result.limit = Number(args[++i]);
    } else if (arg.startsWith('--limit=')) {
      result.limit = Number(arg.slice('--limit='.length));
    } else {
      result.positional.push(arg);
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
const { positional, yes: confirmYes, syncActive, alias: aliasFlag, since, limit, json } = parseArgs(rest);
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
  case 'log':     cmdLog({ alias: aliasFlag || arg || null, sinceArg: since, limit: Number.isFinite(limit) && limit > 0 ? limit : 50, json }); break;
  case 'diagnose': cmdDiagnose(arg, { json, includeRotated: true }); break;
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
  use <alias> [--no-sync-active] switch; best-effort live identity check
                  against api/oauth/account, falls back to byte-level email +
                  pinned UUID when the AT is stale. --no-sync-active skips
                  capturing the outgoing profile's keychain state to disk.
  remove <alias>  delete a profile (cannot remove the active profile)
  wipe --yes      delete Claude Keychain cred + all saved atc-profile creds/catalog
  probe-web       print detected Claude web sessionKey from Firefox cookies
  sync-web <alias> capture current Firefox Claude sessionKey into an existing profile
  log [--alias X] [--since 1h] [--limit N] [--json]
                  tail the credential event log for post-mortem debugging
  diagnose <trace-id> [--json]
                  print the full chronological story of one operation.
                  Matches trace_id / switch_id / rotate_id / add_id fields.
`);
    process.exit(command ? 1 : 0);
}
}
