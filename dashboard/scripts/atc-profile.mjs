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

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const PROFILES_DIR = path.join(os.homedir(), '.claude-profiles');
const PROFILES_JSON = path.join(PROFILES_DIR, 'profiles.json');
const BACKUP_DIR = path.join(PROFILES_DIR, '.backup');

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

function cmdAdd(alias, email) {
  if (!alias || !/^[a-z0-9_-]+$/i.test(alias)) {
    die('Usage: atc-profile add <alias> [--email you@example.com]');
  }

  const catalog = loadCatalog();
  if (catalog.profiles[alias]) {
    die(`Profile "${alias}" already exists. Delete the .cred file manually to re-register.`);
  }

  const blob = keychainExport();

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

  catalog.profiles[alias] = {
    displayName: alias,
    ...(email ? { email } : {}),
    usageCache: placeholderUsageCache(email || null),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!catalog.active) catalog.active = alias;
  saveCatalog(catalog);

  console.log(`✓ Profile "${alias}" registered.${catalog.active === alias ? ' (set as active)' : ''}`);
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

function cmdUse(alias) {
  if (!alias) die('Usage: atc-profile use <alias>');

  const catalog = loadCatalog();
  if (!catalog.profiles[alias]) {
    die(`Unknown profile "${alias}". Run 'atc-profile list' to see available profiles.`);
  }
  if (catalog.active === alias) {
    console.log(`Already on profile "${alias}".`);
    return;
  }

  // 1. Export and back up the current Keychain credential.
  let currentBlob;
  try {
    currentBlob = keychainExport();
    backupCurrent(currentBlob);
  } catch {
    // If there is no current credential (e.g. logged out), skip saving it.
  }

  // 2. Only refresh the active profile's .cred if the Keychain still matches it
  //    (handles silent OAuth token rotation). If it doesn't match, someone ran
  //    `claude /login` for a different account — don't overwrite the stored cred.
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

  // 3. Load the target credential.
  const targetBlob = loadCredential(alias);

  // 4. Swap Keychain entry.
  keychainDelete();
  keychainImport(targetBlob);

  // 5. Update catalog.
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
  delete catalog.profiles[alias];
  saveCatalog(catalog);

  console.log(`✓ Profile "${alias}" removed.`);
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
  console.log('  Next step: run claude, then /login, then atc-profile add <alias> [--email ...].');
}

// ── main ─────────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const [,, command, ...rest] = process.argv;
// Parse --email flag from remaining args
function parseArgs(args) {
  const result = { positional: [], email: null, yes: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) {
      result.email = args[++i];
    } else if (args[i] === '--yes') {
      result.yes = true;
    } else {
      result.positional.push(args[i]);
    }
  }
  return result;
}
const { positional, email: flagEmail, yes: confirmYes } = parseArgs(rest);
const arg = positional[0];
switch (command) {
  case 'add':     cmdAdd(arg, flagEmail); break;
  case 'list':    cmdList(); break;
  case 'current': cmdCurrent(); break;
  case 'use':     cmdUse(arg); break;
  case 'remove':  cmdRemove(arg); break;
  case 'wipe':    cmdWipe(confirmYes); break;
  default:
    console.error(`atc-profile — Claude account profile manager

Commands:
  add <alias> [--email you@example.com]   register the currently-logged-in account under <alias>
  list            show all profiles (* = active)
  current         print the active profile alias
  use <alias>     switch to a different profile
  remove <alias>  delete a profile (cannot remove the active profile)
  wipe --yes      delete Claude Keychain cred + all saved atc-profile creds/catalog
`);
    process.exit(command ? 1 : 0);
}
