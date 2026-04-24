#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  readProfilesJson,
  writeProfilesJson,
  emptyProfileUsageCache,
  getActiveProfile,
  getActiveProfileEmail,
  getProfileEmailByAlias,
  computeProfileStaleness,
  startCredentialWatcher,
  PROFILES_DIR,
  PROFILES_JSON,
} from './modules/profile-catalog.mjs';
import { listCooldowns } from './modules/refresh-budget.mjs';
import { tailEvents as tailCredentialEvents } from './modules/credential-events.mjs';
import {
  buildClaudeRefreshMeta,
  mergeClaudeUsageWindow,
  defaultProviderRateState,
  normalizeProviderRateState,
  readUsageRateCacheFile,
  loadUsageRateCacheFromDisk as loadUsageRateCacheFromDiskModule,
  saveUsageRateCacheToDisk,
} from './modules/usage-cache.mjs';
import {
  fetchCodexbarUsage as fetchCodexbarUsageModule,
  fetchClaudeUsageRateLimited as fetchClaudeUsageRateLimitedModule,
  fetchProviderUsageRateLimited as fetchProviderUsageRateLimitedModule,
  fetchProviderUsageOnce as fetchProviderUsageOnceModule,
} from './modules/provider-usage.mjs';
import { pollUsageUntilProfileActive } from './modules/profile-polling.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.DASHBOARD_PORT || 1111);
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.join(__dirname, 'sessions.json');
const STATE_FILE = process.env.SESSIONS_STATE_FILE || path.join(__dirname, 'state', 'sessions-state.json');
const USAGE_RATE_CACHE_FILE = process.env.USAGE_RATE_CACHE_FILE || path.join(__dirname, 'state', 'usage-rate-cache.json');
const RUN_DIR = process.env.SESSIONS_RUN_DIR || path.join(__dirname, 'run');
const RUNTIME_DIR = process.env.SESSIONS_RUNTIME_DIR || path.join(__dirname, 'runtime');
// Pin the credential event log + refresh-budget state to the dashboard's
// runtime dir so server and CLI agree on a single location.
if (!process.env.ATC_DASHBOARD_RUNTIME_DIR) {
  process.env.ATC_DASHBOARD_RUNTIME_DIR = RUNTIME_DIR;
}
const REPO_ROOT = path.join(__dirname, '..');
const PERSONAS_DIR = path.join(REPO_ROOT, 'personas');
const TTYD_BIN = process.env.TTYD_BIN || '/opt/homebrew/bin/ttyd';
const SHELL_BIN = process.env.SHELL_BIN || '/bin/zsh';
const TMUX_BIN = process.env.TMUX_BIN || 'tmux';
const ENABLE_TMUX_BACKEND = process.env.ENABLE_TMUX_BACKEND !== '0';
const TMUX_SLOT_WINDOW = process.env.TMUX_SLOT_WINDOW || 'atc';
const HOME_DIRECTORY = process.env.HOME || process.env.USERPROFILE || '/';
const DEFAULT_WORKDIR = process.env.DEFAULT_SESSION_WORKDIR || HOME_DIRECTORY;
const SHELL_HOOK_WRITER = process.env.SHELL_HOOK_WRITER || path.join(__dirname, 'scripts', 'shell-hook-writer.mjs');
const ENABLE_SHELL_HOOKS = process.env.ENABLE_SHELL_HOOKS !== '0';
const SOURCE_USER_ZSHRC = process.env.ATC_SOURCE_USER_ZSHRC !== '0';
const USER_ZSHRC_PATH = process.env.ATC_USER_ZSHRC || path.join(process.env.HOME || '', '.zshrc');
const USER_HISTORY_FILE = process.env.ATC_USER_HISTORY_FILE || path.join(process.env.HOME || '', '.zsh_history');
const REFRESH_MS = 8000;
const USAGE_TTL_MS = 10000;
const CLAUDE_USAGE_MIN_INTERVAL_MS = Number(process.env.ATC_CLAUDE_USAGE_MIN_INTERVAL_MS || 120000);
const CODEX_USAGE_MIN_INTERVAL_MS = Number(process.env.ATC_CODEX_USAGE_MIN_INTERVAL_MS || 30000);
const GEMINI_USAGE_MIN_INTERVAL_MS = Number(process.env.ATC_GEMINI_USAGE_MIN_INTERVAL_MS || 30000);
const TELEMETRY_INGEST_MS = Number(process.env.TELEMETRY_INGEST_MS || 2000);
const SLOT_RUN_RETENTION = Number(process.env.SLOT_RUN_RETENTION || 3);
const RECENT_WORKDIR_LIMIT = 5;
const TEMPLATE_NEW_BRAINSTORM = 'new_brainstorm';
const TEMPLATE_CONTINUE_WORK = 'continue_work';
const PERSONA_NONE = 'none';
const PROVIDERS = new Set(['codex', 'claude', 'gemini']);
const ENABLE_PROVIDER_AUTO_LAUNCH = process.env.ATC_AUTO_LAUNCH_PROVIDER !== '0';
const DISABLE_CODEX_BAR = process.argv.includes('--no-codexbar') || process.env.ATC_DISABLE_CODEX_BAR === '1';
const PROVIDER_BOOT_COMMANDS = {
  codex: String(process.env.ATC_PROVIDER_BOOTSTRAP_CODEX || 'codex --dangerously-bypass-approvals-and-sandbox').trim(),
  claude: String(process.env.ATC_PROVIDER_BOOTSTRAP_CLAUDE || 'claude --dangerously-skip-permissions').trim(),
  gemini: String(process.env.ATC_PROVIDER_BOOTSTRAP_GEMINI || 'gemini --yolo').trim(),
};
const PERSONA_CONFIGS = [
  {
    id: PERSONA_NONE,
    label: 'Vanilla',
    description: 'Run without a custom persona prompt.',
    accent: '#64748b',
    promptFile: null,
  },
  {
    id: 'brainstormer',
    label: 'Brainstormer',
    description: 'Explore ideas, surface options, and converge on next steps.',
    accent: '#22c55e',
    hatColor: '#22c55e',
    promptFile: 'brainstormer.md',
  },
  {
    id: 'refactor',
    label: 'Refactor',
    description: 'Simplify code, reduce duplication, and improve structure safely.',
    accent: '#f97316',
    hatColor: '#f97316',
    promptFile: 'refactor.md',
  },
  {
    id: 'tester',
    label: 'Tester',
    description: 'Focus on behavior, test quality, and meaningful coverage.',
    accent: '#8b5a2b',
    hatColor: '#8b5a2b',
    promptFile: 'tester.md',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Inspect changes critically for bugs, regressions, and gaps.',
    accent: '#ef4444',
    hatColor: '#ef4444',
    promptFile: 'reviewer.md',
  },
  {
    id: 'slot_machine_bandit',
    label: 'Slot Machine Bandit',
    description: 'Hunt for the most promising next thread or re-entry point.',
    accent: '#a78bfa',
    hatStyle: 'rainbow',
    promptFile: 'slot-machine-bandit.md',
  },
  {
    id: 'documenter',
    label: 'Documenter',
    description: 'Write clear docs, explain complex systems, and sharpen READMEs.',
    accent: '#14b8a6',
    hatColor: '#14b8a6',
    promptFile: 'documenter.md',
  },
];
const PERSONA_BY_ID = new Map(PERSONA_CONFIGS.map((persona) => [persona.id, persona]));
const PERSONA_SELECTABLE = PERSONA_CONFIGS.filter((persona) => persona.id !== PERSONA_NONE);
const TEMPLATE_PERSONA_IDS = {
  [TEMPLATE_NEW_BRAINSTORM]: [PERSONA_NONE, 'brainstormer'],
  [TEMPLATE_CONTINUE_WORK]: [PERSONA_NONE, 'refactor', 'tester', 'reviewer', 'slot_machine_bandit', 'documenter'],
};
const PERSONA_ALIASES = new Map([
  ['lucky_dip_explorer', 'slot_machine_bandit'],
  ['lucky-dip-explorer', 'slot_machine_bandit'],
]);
const SECOND_BRAIN_DIR = path.join(HOME_DIRECTORY, 'Documents', 'SecondBrain');
const HOT_DIAL_AGENTS = [
  {
    id: 'calendar_manager',
    title: 'Calendar Manager',
    description: 'Personal scheduling assistant tuned for priorities and Google Calendar workflows.',
    icon: 'calendar',
    emoji: '📅',
    enabled: true,
    promptFile: 'calendar-manager.md',
    workdir: SECOND_BRAIN_DIR,
    promptHint: 'Optional first instruction for calendar actions. Example:',
    promptPlaceholder:
      'Create a 45-minute meeting called "Q2 planning with XYZ" next Tuesday at 2:00 PM PT, invite teammate.one@example.com and teammate.two@example.com, and add it to my calendar.',
  },
  {
    id: 'second_brain',
    title: 'Second Brain',
    description: 'Think partner for exploring ideas and retrieving context from your Obsidian vault.',
    icon: 'brain',
    emoji: '🧠',
    enabled: true,
    promptFile: null,
    workdir: SECOND_BRAIN_DIR,
    promptHint: 'Optional first instruction for Obsidian retrieval or note creation. Example:',
    promptPlaceholder:
      'Find my latest notes about AI Traffic Control and create a new Obsidian note titled "Weekly planning - April 21" with action items and open questions.',
  },
  {
    id: 'placeholder_1',
    title: 'Coming Soon',
    description: 'Reserved slot for a future specialized assistant.',
    icon: 'placeholder',
    emoji: '➕',
    enabled: false,
  },
  {
    id: 'placeholder_2',
    title: 'Coming Soon',
    description: 'Reserved slot for a future specialized assistant.',
    icon: 'placeholder',
    emoji: '➕',
    enabled: false,
  },
];
const HOT_DIAL_BY_ID = new Map(HOT_DIAL_AGENTS.filter((agent) => agent.enabled).map((agent) => [agent.id, agent]));

// Provider usage functions imported from modules/provider-usage.mjs
// Wrappers delegate to module versions with proper context

async function fetchCodexbarUsage(provider, source = 'auto', runCommandFn = runCommand, options = {}) {
  return fetchCodexbarUsageModule(provider, source, runCommandFn, options);
}

async function fetchClaudeUsageRateLimited({ force = false } = {}) {
  return fetchClaudeUsageRateLimitedModule({ runCommandFn: runCommand, providerUsageRateCache }, { force });
}

async function fetchProviderUsageRateLimited(provider, source, intervalMs) {
  const result = await fetchProviderUsageRateLimitedModule(
    { runCommandFn: runCommand, providerUsageRateCache },
    provider,
    source,
    intervalMs,
  );
  // Update the global cache state with the result
  if (providerUsageRateCache[provider]) {
    providerUsageRateCache[provider].lastAttemptAtMs = Date.now();
    providerUsageRateCache[provider].lastResult = result;
    saveUsageRateCacheToDisk(providerUsageRateCache);
  }
  return result;
}

async function fetchProviderUsageOnce(providerKey, { force = false } = {}) {
  if (force && providerUsageRateCache[providerKey]) {
    providerUsageRateCache[providerKey].lastAttemptAtMs = 0;
    saveUsageRateCacheToDisk(providerUsageRateCache);
  }
  const result = await fetchProviderUsageOnceModule(
    { runCommandFn: runCommand, providerUsageRateCache },
    providerKey,
    { force },
  );
  const normalized = String(providerKey || '').toLowerCase();
  const labels = normalized === 'gemini' ? ['24h primary', '24h secondary'] : ['5-hour', 'weekly'];
  return decorateUsageWindows(result, labels);
}

async function refreshSingleProviderInBackground(providerKey, { force = false } = {}) {
  const normalized = String(providerKey || '').toLowerCase();
  if (!PROVIDERS.has(normalized)) {
    return usageCache.value || loadingUsageSummary();
  }
  try {
    const nextPayload = await fetchProviderUsageOnce(normalized, { force });
    if (providerUsageRateCache[normalized]) {
      providerUsageRateCache[normalized].lastAttemptAtMs = Date.now();
      providerUsageRateCache[normalized].lastResult = nextPayload;
      saveUsageRateCacheToDisk(providerUsageRateCache);
    }
    const current = usageCache.value || buildBootUsageSummaryFromCaches();
    const nextValue = {
      ...current,
      fetchedAt: new Date().toISOString(),
      [normalized]: nextPayload,
    };
    if (normalized === 'claude') {
      const claudeEmailFallback = getActiveProfileEmail();
      if (nextValue.claude?.ok && !String(nextValue.claude.accountEmail || '').trim() && claudeEmailFallback) {
        nextValue.claude = { ...nextValue.claude, accountEmail: claudeEmailFallback };
      }
      saveActiveProfileUsageCache(nextValue.claude);
    }
    usageCache = { value: nextValue, fetchedAt: Date.now(), pending: null };
    return nextValue;
  } catch (error) {
    const fallback = usageCache.value || errorUsageSummary(error?.message || 'Usage unavailable');
    usageCache = { value: fallback, fetchedAt: Date.now(), pending: null };
    return fallback;
  }
}

function saveActiveProfileUsageCache(claudeUsageValue) {
  if (!claudeUsageValue || typeof claudeUsageValue !== 'object') return;
  const catalog = readProfilesJson();
  const alias = catalog.active;
  if (!alias || !catalog.profiles?.[alias]) return;
  const profile = catalog.profiles[alias];
  const previousCache =
    profile.usageCache && typeof profile.usageCache === 'object'
      ? profile.usageCache
      : emptyProfileUsageCache(profile?.email || null);
  const profileEmail = typeof profile.email === 'string' && profile.email.trim() ? profile.email.trim() : null;
  const usageEmail =
    typeof claudeUsageValue.accountEmail === 'string' && claudeUsageValue.accountEmail.trim()
      ? claudeUsageValue.accountEmail.trim()
      : profileEmail;
  const attemptAtIso =
    typeof claudeUsageValue.lastAttemptAt === 'string' && claudeUsageValue.lastAttemptAt.trim()
      ? claudeUsageValue.lastAttemptAt.trim()
      : (claudeUsageValue.fetchedAt || new Date().toISOString());
  if (claudeUsageValue.ok) {
    profile.usageCache = {
      ...claudeUsageValue,
      accountEmail: usageEmail,
      fetchedAt: claudeUsageValue.fetchedAt || new Date().toISOString(),
      lastAttemptAt: attemptAtIso,
      placeholder: false,
    };
  } else {
    profile.usageCache = {
      ...previousCache,
      ok: false,
      loading: false,
      provider: claudeUsageValue.provider || previousCache.provider || 'claude',
      source: claudeUsageValue.source || previousCache.source || null,
      error: claudeUsageValue.error || previousCache.error || 'Usage unavailable',
      accountEmail: usageEmail || previousCache.accountEmail || null,
      lastAttemptAt: attemptAtIso,
      placeholder: false,
    };
  }
  profile.updatedAt = new Date().toISOString();
  writeProfilesJson(catalog);
}

let usageCache = { value: null, fetchedAt: 0, pending: null };

let providerUsageRateCache = {
  codex: defaultProviderRateState(),
  gemini: defaultProviderRateState(),
};

// saveUsageRateCacheToDisk and cache loading functions imported from modules/usage-cache.mjs
function loadUsageRateCacheFromDisk() {
  providerUsageRateCache = loadUsageRateCacheFromDiskModule();
}

function runCommand(cmd, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, stdout, stderr: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: error.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function runCalendarPython(args, timeoutMs = 15000) {
  const calendarAutomationDir = path.join(HOME_DIRECTORY, 'Code', 'CalendarAutomation');
  const scriptPath = path.join(calendarAutomationDir, args[0]);
  const cmdArgs = [scriptPath, ...args.slice(1)];
  return runCommand('python3', cmdArgs, timeoutMs);
}

function formatCountdown(targetIso) {
  if (!targetIso) return '—';
  const target = new Date(targetIso).getTime();
  if (!Number.isFinite(target)) return '—';
  const diff = target - Date.now();
  if (diff <= 0) return 'reset due';
  const sec = Math.floor(diff / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatLocalTime(iso) {
  if (!iso) return 'n/a';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return 'n/a';
  return dt.toLocaleString();
}

function ago(iso) {
  if (!iso) return 'n/a';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return 'n/a';
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function durationSince(iso) {
  if (!iso) return 'n/a';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return 'n/a';
  let sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const d = Math.floor(sec / 86400);
  sec %= 86400;
  const h = Math.floor(sec / 3600);
  sec %= 3600;
  const m = Math.floor(sec / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function compactText(text, max = 64) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

function normalizeProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return PROVIDERS.has(normalized) ? normalized : 'codex';
}

function providerBootCommand(provider) {
  const normalized = normalizeProvider(provider);
  const command = PROVIDER_BOOT_COMMANDS[normalized];
  return typeof command === 'string' ? command.trim() : '';
}

function normalizePersonaId(personaId, fallbackPersona = PERSONA_NONE) {
  const normalized = String(personaId || '').trim().toLowerCase();
  if (!normalized) return normalizePersonaId(fallbackPersona, PERSONA_NONE);
  const canonical = normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const alias = PERSONA_ALIASES.get(canonical) || canonical;
  return PERSONA_BY_ID.has(alias) ? alias : PERSONA_NONE;
}

function personaConfig(personaId) {
  return PERSONA_BY_ID.get(normalizePersonaId(personaId)) || PERSONA_BY_ID.get(PERSONA_NONE);
}

function personaIdsForTemplate(templateId) {
  return TEMPLATE_PERSONA_IDS[templateId] || [PERSONA_NONE];
}

function normalizePersonaForTemplate(personaId, templateId) {
  const allowed = personaIdsForTemplate(templateId);
  const normalized = normalizePersonaId(personaId);
  return allowed.includes(normalized) ? normalized : allowed[0] || PERSONA_NONE;
}

function normalizePicturePath(picturePath) {
  const raw = String(picturePath || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return raw.replace(/^\/+/, '');
}

function sessionPictureSrc(session) {
  const picturePath = normalizePicturePath(session?.picturePath);
  if (!picturePath) return '';
  if (/^https?:\/\//i.test(picturePath)) return picturePath;
  if (picturePath.startsWith('assets/')) return `/${picturePath}`;
  return `/assets/${picturePath}`;
}

function personaPromptPath(personaId) {
  const persona = personaConfig(personaId);
  if (!persona || persona.id === PERSONA_NONE || !persona.promptFile) return null;
  return path.join(PERSONAS_DIR, persona.promptFile);
}

function shellPromptSubstitutionFromFile(promptFilePath) {
  return `$(cat ${shSingle(promptFilePath)})`;
}

function buildProviderLaunchCommand(provider, workdir, promptFilePath = null) {
  const baseCommand = providerBootCommand(provider);
  const workdirPrefix = workdir ? `cd ${shSingle(workdir)} && ` : '';
  if (!promptFilePath) return `${workdirPrefix}${baseCommand}`;
  return `${workdirPrefix}${baseCommand} "${shellPromptSubstitutionFromFile(promptFilePath)}"`;
}

function normalizeTemplateId(templateId, fallbackTemplate = TEMPLATE_NEW_BRAINSTORM) {
  const normalized = String(templateId || '').trim().toLowerCase();
  if (!normalized) return normalizeTemplateId(fallbackTemplate, TEMPLATE_NEW_BRAINSTORM);
  if (normalized === TEMPLATE_CONTINUE_WORK) return TEMPLATE_CONTINUE_WORK;
  return TEMPLATE_NEW_BRAINSTORM;
}

function normalizeRecentWorkdirs(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const value of input) {
    const candidate = String(value || '').trim();
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
    if (out.length >= RECENT_WORKDIR_LIMIT) break;
  }
  return out;
}

function appendRecentWorkdir(state, workdir) {
  const candidate = String(workdir || '').trim();
  if (!candidate) return;
  const resolved = path.resolve(candidate);
  const existing = normalizeRecentWorkdirs(state.recentWorkdirs);
  state.recentWorkdirs = [resolved, ...existing.filter((entry) => entry !== resolved)].slice(0, RECENT_WORKDIR_LIMIT);
}

async function resolveWorkdirForSpawn(templateId, requestedWorkdir) {
  if (templateId === TEMPLATE_NEW_BRAINSTORM) return HOME_DIRECTORY;
  const candidate = String(requestedWorkdir || '').trim() || HOME_DIRECTORY;
  const fullPath = path.resolve(candidate);
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    throw new Error(`workdir does not exist: ${candidate}`);
  }
  if (!stat.isDirectory()) throw new Error(`workdir is not a directory: ${candidate}`);
  return fullPath;
}

async function listDirectoryOptions(inputPath) {
  const normalized = path.resolve(String(inputPath || '').trim() || HOME_DIRECTORY);
  let stat;
  try {
    stat = await fs.stat(normalized);
  } catch {
    throw new Error('directory does not exist');
  }
  if (!stat.isDirectory()) throw new Error('path is not a directory');

  const entries = await fs.readdir(normalized, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({
      name: entry.name,
      path: path.join(normalized, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = normalized === '/' ? null : path.dirname(normalized);
  return { path: normalized, parent, directories };
}

function parseWindow(windowValue, fallbackMinutes = null) {
  if (!windowValue || typeof windowValue !== 'object') return null;
  const usedPercent = Number(windowValue.usedPercent ?? 0);
  const windowMinutes = Number(windowValue.windowMinutes ?? fallbackMinutes ?? 0);
  return {
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : 0,
    windowMinutes: Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : fallbackMinutes,
    resetsAt: windowValue.resetsAt || null,
    resetDescription: windowValue.resetDescription || null,
  };
}

// fetchCodexbarUsage wrapper imported from modules/provider-usage.mjs

function decorateUsageWindows(payload, labels) {
  if (!payload?.ok) return payload;
  const out = { ...payload };
  const [primaryLabel, secondaryLabel] = labels;
  out.primary = payload.primary
    ? {
        ...payload.primary,
        label: primaryLabel,
        resetIn: formatCountdown(payload.primary.resetsAt),
        resetAtLocal: formatLocalTime(payload.primary.resetsAt),
      }
    : null;
  out.secondary = payload.secondary
    ? {
        ...payload.secondary,
        label: secondaryLabel,
        resetIn: formatCountdown(payload.secondary.resetsAt),
        resetAtLocal: formatLocalTime(payload.secondary.resetsAt),
      }
    : null;
  return out;
}

async function getUsageSummary() {
  const now = Date.now();
  if (usageCache.value && now - usageCache.fetchedAt < USAGE_TTL_MS) return usageCache.value;
  if (usageCache.pending) return usageCache.pending;
  refreshUsageSummaryInBackground();
  return usageCache.pending;
}

function loadingUsageSummary() {
  const loading = (provider) => ({ ok: false, provider, loading: true, error: null });
  return {
    fetchedAt: null,
    codex: loading('codex'),
    claude: loading('claude'),
    gemini: loading('gemini'),
  };
}

function errorUsageSummary(errorMessage) {
  const errorPayload = (provider) => ({ ok: false, provider, loading: false, error: errorMessage || 'Usage unavailable' });
  return {
    fetchedAt: new Date().toISOString(),
    codex: errorPayload('codex'),
    claude: errorPayload('claude'),
    gemini: errorPayload('gemini'),
  };
}

function buildCachedProviderSnapshot(providerKey, labels, intervalMs, sourceFallback) {
  const state = providerUsageRateCache[providerKey];
  const lastAttemptAtMs = Number(state?.lastAttemptAtMs || 0);
  const hasRecentAttempt =
    Number.isFinite(lastAttemptAtMs) && lastAttemptAtMs > 0 && Date.now() - lastAttemptAtMs < intervalMs;
  const baseResult =
    state?.lastResult && typeof state.lastResult === 'object'
      ? { ...state.lastResult }
      : (lastAttemptAtMs > 0
          ? {
              ok: false,
              provider: providerKey,
              loading: false,
              error: 'Rate limited: waiting for next refresh window',
            }
          : { ok: false, provider: providerKey, loading: true, error: null });
  const merged = {
    ...baseResult,
    provider: providerKey,
    source: baseResult.source || `${sourceFallback}-cache`,
    throttled: hasRecentAttempt,
    ...(lastAttemptAtMs > 0 ? buildClaudeRefreshMeta(lastAttemptAtMs, intervalMs) : {}),
  };
  return decorateUsageWindows(merged, labels);
}

function buildCachedClaudeSnapshot() {
  const catalog = readProfilesJson();
  const activeAlias = String(catalog.active || '').trim();
  const profile = activeAlias && catalog.profiles ? catalog.profiles[activeAlias] : null;
  const profileEmail = typeof profile?.email === 'string' && profile.email.trim() ? profile.email.trim() : null;
  const cache =
    profile?.usageCache && typeof profile.usageCache === 'object'
      ? { ...profile.usageCache }
      : emptyProfileUsageCache(profileEmail);
  const lastAttemptIso = cache.lastAttemptAt || cache.fetchedAt || null;
  const lastAttemptAtMs = lastAttemptIso ? Date.parse(lastAttemptIso) : NaN;
  const hasRecentAttempt =
    Number.isFinite(lastAttemptAtMs) && Date.now() - lastAttemptAtMs < CLAUDE_USAGE_MIN_INTERVAL_MS;
  const merged = {
    ...cache,
    provider: 'claude',
    source: cache.source || 'cli-cache',
    throttled: hasRecentAttempt,
    ...(Number.isFinite(lastAttemptAtMs) ? buildClaudeRefreshMeta(lastAttemptAtMs, CLAUDE_USAGE_MIN_INTERVAL_MS) : {}),
  };
  return decorateUsageWindows(merged, ['5-hour', 'weekly']);
}

function buildBootUsageSummaryFromCaches() {
  return {
    fetchedAt: null,
    codex: buildCachedProviderSnapshot('codex', ['5-hour', 'weekly'], CODEX_USAGE_MIN_INTERVAL_MS, 'cli'),
    claude: buildCachedClaudeSnapshot(),
    gemini: buildCachedProviderSnapshot('gemini', ['24h primary', '24h secondary'], GEMINI_USAGE_MIN_INTERVAL_MS, 'auto'),
  };
}

function refreshUsageSummaryInBackground({ force = {} } = {}) {
  // Callers (notably /api/profiles/switch) pass { force: { claude: true } } to
  // bypass the in-process min-interval throttle — otherwise a fresh switch can
  // return the previous account's cached windows with throttled=true, which the
  // frontend polling accepts as "done" and renders stale data on the card.
  if (usageCache.pending) return usageCache.pending;
  let pending = null;
  pending = (async () => {
    try {
      const [codexRaw, claudeRaw, geminiRaw] = await Promise.all([
        fetchProviderUsageRateLimited('codex', 'cli', CODEX_USAGE_MIN_INTERVAL_MS),
        fetchClaudeUsageRateLimited({ force: !!force.claude }),
        fetchProviderUsageRateLimited('gemini', 'auto', GEMINI_USAGE_MIN_INTERVAL_MS),
      ]);
      const claudeEmailFallback = getActiveProfileEmail();
      const claudeDecorated =
        claudeRaw?.ok && !String(claudeRaw.accountEmail || '').trim() && claudeEmailFallback
          ? { ...claudeRaw, accountEmail: claudeEmailFallback }
          : claudeRaw;

      const value = {
        fetchedAt: new Date().toISOString(),
        codex: decorateUsageWindows(codexRaw, ['5-hour', 'weekly']),
        claude: decorateUsageWindows(claudeDecorated, ['5-hour', 'weekly']),
        gemini: decorateUsageWindows(geminiRaw, ['24h primary', '24h secondary']),
      };
      saveActiveProfileUsageCache(value.claude);
      if (usageCache.pending === pending) {
        usageCache = { value, fetchedAt: Date.now(), pending: null };
        return value;
      }
      return usageCache.value || value;
    } catch (error) {
      const fallback = usageCache.value || errorUsageSummary(error?.message || 'Usage unavailable');
      if (usageCache.pending === pending) {
        usageCache = { value: fallback, fetchedAt: Date.now(), pending: null };
        return fallback;
      }
      return usageCache.value || fallback;
    }
  })();
  usageCache.pending = pending;
  return pending;
}

function getUsageSnapshot() {
  const now = Date.now();
  const activeProfile = getActiveProfile();
  const activeProfileEmail = getProfileEmailByAlias(activeProfile);
  const withProfileEmail = (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const withNextRefresh = (payload) => {
      if (!payload || typeof payload !== 'object') return payload;
      const nextRefreshMs = payload.nextRefreshAt ? Date.parse(payload.nextRefreshAt) : NaN;
      const nextRefreshInSec = Number.isFinite(nextRefreshMs)
        ? Math.ceil(Math.max(0, nextRefreshMs - Date.now()) / 1000)
        : payload.nextRefreshInSec;
      return { ...payload, nextRefreshInSec };
    };
    return {
      ...snapshot,
      codex: withNextRefresh(snapshot.codex),
      claude: {
        ...withNextRefresh(snapshot.claude),
        ...(activeProfileEmail ? { accountEmail: activeProfileEmail } : {}),
      },
      gemini: withNextRefresh(snapshot.gemini),
    };
  };
  if (usageCache.value && now - usageCache.fetchedAt < USAGE_TTL_MS) {
    return { ...withProfileEmail(usageCache.value), activeProfile };
  }
  refreshUsageSummaryInBackground();
  return { ...(withProfileEmail(usageCache.value) || loadingUsageSummary()), activeProfile };
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readSessionsConfig() {
  try {
    const text = await fs.readFile(SESSIONS_FILE, 'utf8');
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((s) => ({
        name: String(s.name ?? '').trim(),
        publicPort: Number(s.publicPort),
        backendPort: Number(s.backendPort),
        description: s.description ? String(s.description) : '',
        picturePath: String(s.picturePath || s.pictureUrl || '').trim(),
      }))
      .filter((s) => s.name && Number.isFinite(s.publicPort) && Number.isFinite(s.backendPort));
  } catch {
    return [];
  }
}

function defaultSessionState(cfg) {
  return {
    name: cfg.name,
    status: 'idle',
    taskTitle: `${cfg.name} task`,
    workdir: DEFAULT_WORKDIR,
    provider: 'codex',
    templateId: TEMPLATE_NEW_BRAINSTORM,
    personaId: PERSONA_NONE,
    agentType: 'none',
    spawnedAt: null,
    runId: null,
    firstInteractionAt: null,
    lastInteractionAt: null,
    pid: null,
    lastExitAt: null,
    error: null,
  };
}

async function loadState() {
  const cfg = await readSessionsConfig();
  let current = { version: 1, updatedAt: new Date().toISOString(), sessions: {}, recentWorkdirs: [] };
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      current = parsed;
    }
  } catch {
    // create fresh below
  }

  const merged = { ...current, version: 1, updatedAt: new Date().toISOString(), sessions: { ...current.sessions } };
  merged.recentWorkdirs = normalizeRecentWorkdirs(current.recentWorkdirs);
  for (const slot of cfg) {
    if (!merged.sessions[slot.name]) merged.sessions[slot.name] = defaultSessionState(slot);
    merged.sessions[slot.name].name = slot.name;
    if (!merged.sessions[slot.name].workdir) merged.sessions[slot.name].workdir = DEFAULT_WORKDIR;
    merged.sessions[slot.name].provider = normalizeProvider(merged.sessions[slot.name].provider);
    merged.sessions[slot.name].templateId = normalizeTemplateId(merged.sessions[slot.name].templateId);
    merged.sessions[slot.name].personaId = normalizePersonaId(merged.sessions[slot.name].personaId);
    if (!merged.sessions[slot.name].taskTitle) merged.sessions[slot.name].taskTitle = `${slot.name} task`;
    if (!merged.sessions[slot.name].agentType) merged.sessions[slot.name].agentType = 'none';
    if (!Object.hasOwn(merged.sessions[slot.name], 'runId')) merged.sessions[slot.name].runId = null;
    if (merged.sessions[slot.name].status !== 'active') {
      merged.sessions[slot.name].runId = null;
      merged.sessions[slot.name].spawnedAt = null;
      merged.sessions[slot.name].firstInteractionAt = null;
      merged.sessions[slot.name].lastInteractionAt = null;
      merged.sessions[slot.name].pid = null;
    }
  }

  const names = new Set(cfg.map((c) => c.name));
  for (const key of Object.keys(merged.sessions)) {
    if (!names.has(key)) delete merged.sessions[key];
  }

  await saveState(merged);
  return merged;
}

// Serializes all state file writes to prevent concurrent overwrites.
let _stateWriteTail = Promise.resolve();
async function saveState(state) {
  const prev = _stateWriteTail;
  let done;
  _stateWriteTail = new Promise((r) => { done = r; });
  await prev;
  try {
    await ensureDir(STATE_FILE);
    const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    state.updatedAt = new Date().toISOString();
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, STATE_FILE);
  } finally {
    done();
  }
}

async function readRecentWorkdirsFromState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeRecentWorkdirs(parsed?.recentWorkdirs);
  } catch {
    return [];
  }
}

function checkPortOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    function finish(isOpen) {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(isOpen);
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function waitForTtydReady(port, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 900);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/?atc_ready_probe=1`, {
        method: 'GET',
        cache: 'no-store',
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (response.ok) {
        const html = await response.text();
        if (html && html.toLowerCase().includes('ttyd')) return true;
      }
    } catch {
      clearTimeout(timer);
      // continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function pidFileForBackend(backendPort) {
  return path.join(RUN_DIR, `ttyd-${backendPort}.pid`);
}

function logFileForBackend(backendPort) {
  return path.join(RUN_DIR, `ttyd-${backendPort}.log`);
}

function tmuxSessionNameForSlot(slotName) {
  const clean = String(slotName || 'slot')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'slot';
}

async function commandExists(cmd) {
  if (!cmd) return false;
  if (cmd.includes('/')) return fsSync.existsSync(cmd);
  const result = await runCommand('sh', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], 3000);
  return !!result.ok;
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function slotSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'slot';
}

function makeRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function slotRuntimePaths(slotName) {
  const slug = slotSlug(slotName);
  const slotDir = path.join(RUNTIME_DIR, 'slots', slug);
  const currentDir = path.join(slotDir, 'current');
  return {
    slug,
    slotDir,
    currentDir,
    metaFile: path.join(currentDir, 'meta.json'),
    eventsFile: path.join(currentDir, 'events.jsonl'),
    derivedFile: path.join(currentDir, 'derived.json'),
    zdotdir: path.join(currentDir, '.zsh_atc'),
    zshrcFile: path.join(currentDir, '.zsh_atc', '.zshrc'),
  };
}

function parseJsonLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row && typeof row === 'object');
}

async function readEvents(filePath, runId = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const rows = parseJsonLines(raw);
    if (!runId) return rows;
    return rows.filter((row) => row.runId === runId);
  } catch {
    return [];
  }
}

async function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, payload) {
  await ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
}

async function emitSlotEvent(hookEnv, eventType, cwd = '', commandText = '', durationMs = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHELL_HOOK_WRITER], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        ...hookEnv,
        ATC_EVENT_TYPE: eventType || '',
        ATC_EVENT_CWD: cwd || '',
        ATC_EVENT_COMMAND: commandText || '',
        ATC_EVENT_DURATION_MS: durationMs || '',
      },
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // no-op
      }
      resolve();
    }, 1200);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function shSingle(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function shellWithHookEnvCommand(shellConfig) {
  if (!shellConfig?.zdotdir) return `${SHELL_BIN} -il`;
  return `env ZDOTDIR=${shSingle(shellConfig.zdotdir)} ATC_ZDOTDIR=${shSingle(shellConfig.zdotdir)} ${shSingle(SHELL_BIN)} -il`;
}

async function tmuxWindowExists(sessionName, windowName) {
  const result = await runCommand(TMUX_BIN, ['list-windows', '-t', sessionName, '-F', '#{window_name}'], 3000);
  if (!result.ok) return false;
  return (result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .includes(windowName);
}

async function ensureTmuxSlotWindow(sessionName, workdir, shellConfig) {
  const shellCmd = shellWithHookEnvCommand(shellConfig);
  const hasSession = await runCommand(TMUX_BIN, ['has-session', '-t', sessionName], 3000);
  if (!hasSession.ok) {
    const created = await runCommand(TMUX_BIN, ['new-session', '-d', '-s', sessionName, '-n', TMUX_SLOT_WINDOW, '-c', workdir, shellCmd], 5000);
    if (!created.ok) throw new Error(`failed to create tmux session ${sessionName}: ${created.stderr || 'unknown error'}`);
    return;
  }

  const hasWindow = await tmuxWindowExists(sessionName, TMUX_SLOT_WINDOW);
  if (hasWindow) {
    // Window already exists — respawn the pane with the new shell config.
    const respawned = await runCommand(TMUX_BIN, ['respawn-pane', '-k', '-t', `${sessionName}:${TMUX_SLOT_WINDOW}.0`, '-c', workdir, shellCmd], 5000);
    if (!respawned.ok)
      throw new Error(`failed to respawn tmux pane ${sessionName}:${TMUX_SLOT_WINDOW}.0: ${respawned.stderr || 'unknown error'}`);
  } else {
    // Session exists but no atc window — rename the first window instead of
    // creating a second tab, then respawn the pane with the hook-enabled shell.
    const firstWindow = await runCommand(TMUX_BIN, ['list-windows', '-t', sessionName, '-F', '#{window_index}'], 3000);
    const firstIdx = (firstWindow.stdout || '').trim().split('\n')[0] || '0';
    await runCommand(TMUX_BIN, ['rename-window', '-t', `${sessionName}:${firstIdx}`, TMUX_SLOT_WINDOW], 3000);
    const respawned = await runCommand(TMUX_BIN, ['respawn-pane', '-k', '-t', `${sessionName}:${TMUX_SLOT_WINDOW}.0`, '-c', workdir, shellCmd], 5000);
    if (!respawned.ok)
      throw new Error(`failed to respawn tmux pane ${sessionName}:${TMUX_SLOT_WINDOW}.0: ${respawned.stderr || 'unknown error'}`);
  }

  const selected = await runCommand(TMUX_BIN, ['select-window', '-t', `${sessionName}:${TMUX_SLOT_WINDOW}`], 3000);
  if (!selected.ok) throw new Error(`failed to select tmux window ${sessionName}:${TMUX_SLOT_WINDOW}: ${selected.stderr || 'unknown error'}`);
}

async function launchProviderInTmuxSlot(sessionName, provider, sessionState) {
  if (!ENABLE_PROVIDER_AUTO_LAUNCH) return;
  const promptFilePath = sessionState?.agentPromptFile || personaPromptPath(sessionState?.personaId);
  const command = buildProviderLaunchCommand(provider, sessionState?.workdir || DEFAULT_WORKDIR, promptFilePath);
  if (!command) return;

  const target = `${sessionName}:${TMUX_SLOT_WINDOW}.0`;
  // Let the shell initialize before injecting the provider command.
  await new Promise((resolve) => setTimeout(resolve, 220));

  const typed = await runCommand(TMUX_BIN, ['send-keys', '-t', target, '-l', command], 3000);
  if (!typed.ok) throw new Error(`failed to stage provider command in tmux pane ${target}: ${typed.stderr || 'unknown error'}`);
  const entered = await runCommand(TMUX_BIN, ['send-keys', '-t', target, 'Enter'], 3000);
  if (!entered.ok) throw new Error(`failed to run provider command in tmux pane ${target}: ${entered.stderr || 'unknown error'}`);
}

async function readTmuxSlotPaneState(slotName) {
  if (!ENABLE_TMUX_BACKEND) return null;
  const sessionName = tmuxSessionNameForSlot(slotName);
  const result = await runCommand(
    TMUX_BIN,
    ['list-panes', '-t', sessionName, '-F', '#{window_name}\t#{pane_active}\t#{pane_current_path}\t#{window_activity}'],
    3000
  );
  if (!result.ok) return null;

  const rows = (result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [windowName, paneActive, paneCurrentPath, windowActivity] = line.split('\t');
      return {
        windowName: windowName || '',
        paneActive: paneActive === '1',
        paneCurrentPath: paneCurrentPath || null,
        windowActivity: Number(windowActivity),
      };
    });
  if (rows.length === 0) return null;

  const preferred = rows.find((row) => row.windowName === TMUX_SLOT_WINDOW) || rows.find((row) => row.paneActive) || rows[0];
  const activityMs = Number.isFinite(preferred.windowActivity) && preferred.windowActivity > 0 ? preferred.windowActivity * 1000 : null;
  return {
    cwd: preferred.paneCurrentPath || null,
    lastInteractionAt: activityMs ? new Date(activityMs).toISOString() : null,
  };
}

function hashPaneContent(content) {
  return createHash('sha1').update(String(content || ''), 'utf8').digest('hex');
}

async function readTmuxSlotPaneFingerprint(slotName) {
  if (!ENABLE_TMUX_BACKEND) return null;
  const sessionName = tmuxSessionNameForSlot(slotName);
  const target = `${sessionName}:${TMUX_SLOT_WINDOW}.0`;
  const result = await runCommand(
    TMUX_BIN,
    // Capture visible pane text (joined wraps), enough lines for stable change detection.
    ['capture-pane', '-p', '-J', '-t', target, '-S', '-160'],
    3000
  );
  if (!result.ok) return null;
  const normalized = (result.stdout || '')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .trimEnd();
  return hashPaneContent(normalized);
}

function buildAtcZshrc(env) {
  return [
    '#!/usr/bin/env zsh',
    '# Generated by AI Traffic Control for shell-level telemetry hooks.',
    '# Source user rc optionally, then install telemetry hooks.',
    'setopt prompt_subst',
    'autoload -Uz colors && colors',
    'export SHELL=/bin/zsh',
    'if [[ -z "${PS1:-}" ]]; then',
    '  PS1="%F{cyan}%n@%m%f:%F{yellow}%~%f %# "',
    'fi',
    '',
    `typeset -gx ATC_SLOT=${shSingle(env.ATC_SLOT)}`,
    `typeset -gx ATC_RUN_ID=${shSingle(env.ATC_RUN_ID)}`,
    `typeset -gx ATC_SLOT_DIR=${shSingle(env.ATC_SLOT_DIR)}`,
    `typeset -gx ATC_CURRENT_DIR=${shSingle(env.ATC_CURRENT_DIR)}`,
    `typeset -gx ATC_EVENTS_FILE=${shSingle(env.ATC_EVENTS_FILE)}`,
    `typeset -gx ATC_META_FILE=${shSingle(env.ATC_META_FILE)}`,
    `typeset -gx ATC_DERIVED_FILE=${shSingle(env.ATC_DERIVED_FILE)}`,
    `typeset -gx ATC_HOOK_WRITER=${shSingle(env.ATC_HOOK_WRITER)}`,
    `typeset -gx ATC_SOURCE_USER_ZSHRC=${shSingle(env.ATC_SOURCE_USER_ZSHRC)}`,
    `typeset -gx ATC_USER_ZSHRC=${shSingle(env.ATC_USER_ZSHRC)}`,
    `typeset -gx ATC_USER_HISTORY_FILE=${shSingle(env.ATC_USER_HISTORY_FILE)}`,
    '',
    'if [[ "${ATC_SOURCE_USER_ZSHRC:-1}" != "0" && -n "${ATC_USER_ZSHRC:-}" && -r "${ATC_USER_ZSHRC}" ]]; then',
    '  source "${ATC_USER_ZSHRC}"',
    'fi',
    '',
    '# Force HISTFILE to the user history — ZDOTDIR causes zsh to default',
    '# HISTFILE to $ZDOTDIR/.zsh_history before any rc file runs, so a',
    '# conditional guard (if -z) would never override it.',
    'export HISTFILE="${ATC_USER_HISTORY_FILE:-$HOME/.zsh_history}"',
    'if [[ ! -e "$HISTFILE" ]]; then',
    '  : > "$HISTFILE" 2>/dev/null || true',
    'fi',
    'setopt APPEND_HISTORY',
    'setopt INC_APPEND_HISTORY',
    'setopt SHARE_HISTORY',
    'setopt HIST_FCNTL_LOCK',
    'fc -R "$HISTFILE" 2>/dev/null || true',
    '',
    'if [[ -z "${ATC_SHELL_HOOKS_ACTIVE:-}" ]]; then',
    '  typeset -g ATC_SHELL_HOOKS_ACTIVE=1',
    '  typeset -g _ATC_PREEXEC_EPOCH=""',
    '',
    '  _atc_emit() {',
    '    local event_type="$1"',
    '    local command_text="${2-}"',
    '    local duration_ms="${3-}"',
    '    ATC_EVENT_TYPE="$event_type" \\',
    '    ATC_EVENT_CWD="$PWD" \\',
    '    ATC_EVENT_COMMAND="$command_text" \\',
    '    ATC_EVENT_DURATION_MS="$duration_ms" \\',
    '    "$ATC_HOOK_WRITER" >/dev/null 2>&1 || true',
    '  }',
    '',
    '  _atc_preexec() {',
    '    _ATC_PREEXEC_EPOCH="$EPOCHREALTIME"',
    '    _atc_emit "preexec" "$1" ""',
    '  }',
    '',
    '  _atc_precmd() {',
    '    local duration_ms=""',
    '    if [[ -n "$_ATC_PREEXEC_EPOCH" ]]; then',
    '      duration_ms=$(( (EPOCHREALTIME - _ATC_PREEXEC_EPOCH) * 1000 ))',
    '    fi',
    '    _ATC_PREEXEC_EPOCH=""',
    '    _atc_emit "precmd" "" "$duration_ms"',
    '  }',
    '',
    '  _atc_chpwd() {',
    '    _atc_emit "chpwd" "" ""',
    '  }',
    '',
    '  autoload -Uz add-zsh-hook',
    '  add-zsh-hook preexec _atc_preexec',
    '  add-zsh-hook precmd _atc_precmd',
    '  add-zsh-hook chpwd _atc_chpwd',
    '',
    '  _atc_emit "shell_start" "" ""',
    'fi',
    '',
  ].join('\n');
}

async function ensureSlotRuntime(slotName, runId, workdir, sessionState = {}) {
  const paths = slotRuntimePaths(slotName);
  await fs.mkdir(paths.currentDir, { recursive: true });
  await fs.mkdir(paths.zdotdir, { recursive: true });

  const provider = normalizeProvider(sessionState.provider);
  const templateId = normalizeTemplateId(sessionState.templateId);
  const personaId = normalizePersonaId(sessionState.personaId);
  const persona = personaConfig(personaId);

  const now = new Date().toISOString();
  const meta = {
    slot: slotName,
    runId,
    activeSince: now,
    lastInteractionAt: now,
    cwd: workdir || DEFAULT_WORKDIR,
    eventCount: 0,
    shellStartedAt: now,
    provider,
    templateId,
    personaId,
    personaLabel: persona?.label || 'Vanilla',
  };
  const derived = {
    slot: slotName,
    runId,
    activeSince: now,
    lastInteractionAt: now,
    cwd: workdir || DEFAULT_WORKDIR,
    lastEventType: 'shell_start',
    eventCount: 0,
    shellStartedAt: now,
    durationMs: null,
    provider,
    templateId,
    personaId,
    personaLabel: persona?.label || 'Vanilla',
  };

  await writeJsonAtomic(paths.metaFile, meta);
  await writeJsonAtomic(paths.derivedFile, derived);
  await fs.writeFile(paths.eventsFile, '', 'utf8');

  const hookEnv = {
    ATC_SLOT: slotName,
    ATC_RUN_ID: runId,
    ATC_SLOT_DIR: paths.slotDir,
    ATC_CURRENT_DIR: paths.currentDir,
    ATC_EVENTS_FILE: paths.eventsFile,
    ATC_META_FILE: paths.metaFile,
    ATC_DERIVED_FILE: paths.derivedFile,
    ATC_HOOK_WRITER: SHELL_HOOK_WRITER,
    ATC_SOURCE_USER_ZSHRC: SOURCE_USER_ZSHRC ? '1' : '0',
    ATC_USER_ZSHRC: USER_ZSHRC_PATH,
    ATC_USER_HISTORY_FILE: USER_HISTORY_FILE,
    ATC_PROVIDER: provider,
    ATC_TEMPLATE_ID: templateId,
    ATC_PERSONA_ID: personaId,
  };

  await fs.writeFile(paths.zshrcFile, buildAtcZshrc(hookEnv), { mode: 0o644 });
  return { paths, hookEnv };
}

async function rotateSlotCurrent(slotName, previousRunId = null) {
  const runtime = slotRuntimePaths(slotName);
  const runsDir = path.join(runtime.slotDir, 'runs');
  await fs.mkdir(runsDir, { recursive: true });

  let hasCurrent = false;
  try {
    const entries = await fs.readdir(runtime.currentDir);
    hasCurrent = entries.length > 0;
  } catch {
    hasCurrent = false;
  }

  if (hasCurrent) {
    const baseName = previousRunId || `archived-${Date.now().toString(36)}`;
    let archiveDir = path.join(runsDir, baseName);
    let suffix = 1;
    while (fsSync.existsSync(archiveDir)) {
      archiveDir = path.join(runsDir, `${baseName}-${suffix}`);
      suffix += 1;
    }
    await fs.rename(runtime.currentDir, archiveDir);
  }

  await fs.mkdir(runtime.currentDir, { recursive: true });

  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const dirs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const full = path.join(runsDir, entry.name);
          const st = await fs.stat(full);
          return { full, mtimeMs: st.mtimeMs };
        })
    );
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toDelete = dirs.slice(Math.max(0, SLOT_RUN_RETENTION));
    await Promise.all(toDelete.map((entry) => fs.rm(entry.full, { recursive: true, force: true })));
  } catch {
    // Keep serving even if retention pruning fails.
  }
}


function extractContextWindowPct(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const payload = events[i]?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const candidates = [
      payload?.context_window_pct,
      payload?.contextWindowPct,
      payload?.context_window_percent,
      payload?.contextWindowPercent,
      payload?.usage?.context_window_pct,
      payload?.usage?.contextWindowPct,
      payload?.usage?.context_window_percent,
      payload?.usage?.contextWindowPercent,
      payload?.token_usage?.context_window_pct,
      payload?.tokenUsage?.contextWindowPct,
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function selectLastInteractionAtFromOutput(events, tmuxPaneState, stateRecord) {
  // Prefer events that usually occur after terminal output is rendered,
  // and avoid prompt-submission hooks that can be user/viewer noise.
  const outputLikeEvents = new Set(['precmd', 'PostToolUse', 'Stop']);
  const lastOutputLike = [...events].reverse().find((e) => outputLikeEvents.has(e.eventType));
  if (lastOutputLike?.ts) return lastOutputLike.ts;

  const tmuxTs = tmuxPaneState?.lastInteractionAt;
  if (typeof tmuxTs === 'string' && tmuxTs.trim()) return tmuxTs;

  return stateRecord?.lastInteractionAt || null;
}

async function recomputeDerivedForSlot(slot, stateRecord) {
  if (!stateRecord?.runId) return;
  const runtime = slotRuntimePaths(slot.name);
  const prevDerived = await readJsonSafe(runtime.derivedFile, null);
  const events = await readEvents(runtime.eventsFile, stateRecord.runId);
  if (events.length === 0) return;

  const first = events[0];
  const last = events[events.length - 1];
  const lastWithCwd = [...events].reverse().find((e) => typeof e.cwd === 'string' && e.cwd.trim());
  const lastProvider = [...events].reverse().find((e) => e.provider)?.provider || null;
  const lastPrompt = [...events].reverse().find((e) => e.eventType === 'UserPromptSubmit');
  const lastStop = [...events].reverse().find((e) => e.eventType === 'Stop');
  const turnCount = events.filter((e) => e.eventType === 'UserPromptSubmit').length;
  const contextWindowPct = extractContextWindowPct(events);
  const [tmuxPaneState, paneFingerprint] = await Promise.all([
    readTmuxSlotPaneState(slot.name),
    readTmuxSlotPaneFingerprint(slot.name),
  ]);

  // A pane fingerprint change means visible terminal output changed.
  const paneOutputAt = paneFingerprint && paneFingerprint !== prevDerived?.paneFingerprint
    ? new Date().toISOString()
    : (typeof prevDerived?.paneOutputAt === 'string' ? prevDerived.paneOutputAt : null);
  const eventOutputAt = selectLastInteractionAtFromOutput(events, tmuxPaneState, stateRecord);
  const paneOutputMs = paneOutputAt ? new Date(paneOutputAt).getTime() : NaN;
  const eventOutputMs = eventOutputAt ? new Date(eventOutputAt).getTime() : NaN;
  const interactionAt = Number.isFinite(paneOutputMs) && (!Number.isFinite(eventOutputMs) || paneOutputMs > eventOutputMs)
    ? paneOutputAt
    : eventOutputAt;

  const derived = {
    slot: slot.name,
    runId: stateRecord.runId,
    provider: lastProvider,
    activeSince: first.ts || stateRecord.spawnedAt || null,
    lastInteractionAt: interactionAt || stateRecord.lastInteractionAt || null,
    cwd: tmuxPaneState?.cwd || lastWithCwd?.cwd || stateRecord.workdir || null,
    lastEventType: last.eventType || null,
    eventCount: events.length,
    shellStartedAt: events.find((e) => e.eventType === 'shell_start')?.ts || null,
    lastCommand: [...events].reverse().find((e) => e.command)?.command || null,
    lastCommandAt: [...events].reverse().find((e) => e.command)?.ts || null,
    durationMs: Number.isFinite(Number(last.durationMs)) ? Number(last.durationMs) : null,
    lastUserPromptAt: lastPrompt?.ts || null,
    lastAssistantStopAt: lastStop?.ts || null,
    turnCount,
    agentType: HOT_DIAL_BY_ID.has(stateRecord?.agentType) ? stateRecord.agentType : 'none',
    contextWindowPct,
    paneFingerprint,
    paneOutputAt,
  };

  await writeJsonAtomic(runtime.derivedFile, derived);
}

async function ingestTelemetry() {
  const [cfg, state] = await Promise.all([readSessionsConfig(), loadState()]);
  await Promise.all(
    cfg.map(async (slot) => {
      const st = state.sessions[slot.name];
      if (!st || st.status !== 'active' || !st.runId) return;
      await recomputeDerivedForSlot(slot, st);
    })
  );
}


async function killPid(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 600));
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // no-op
    }
  }
}

async function findListeningPid(port) {
  const result = await runCommand('lsof', ['-tiTCP:' + String(port), '-sTCP:LISTEN'], 3000);
  if (!result.ok) return null;
  const line = (result.stdout || '').trim().split(/\n+/).find(Boolean);
  const pid = Number(line);
  return Number.isFinite(pid) ? pid : null;
}

async function spawnSessionBackend(slot, sessionState, runtimeEnv, shellConfig) {
  if (!fsSync.existsSync(TTYD_BIN)) throw new Error(`ttyd not found at ${TTYD_BIN}`);
  await fs.mkdir(RUN_DIR, { recursive: true });

  const backendTaken = await checkPortOpen(slot.backendPort);
  if (backendTaken) throw new Error(`backend port ${slot.backendPort} is already in use`);

  if (ENABLE_TMUX_BACKEND) {
    const tmuxFound = await commandExists(TMUX_BIN);
    if (!tmuxFound) throw new Error(`tmux not found at ${TMUX_BIN}`);
  }

  const slotWorkdir = sessionState.workdir || DEFAULT_WORKDIR;
  const tmuxSessionName = tmuxSessionNameForSlot(slot.name);
  if (ENABLE_TMUX_BACKEND) {
    await ensureTmuxSlotWindow(tmuxSessionName, slotWorkdir, shellConfig);
    await launchProviderInTmuxSlot(tmuxSessionName, sessionState.provider, sessionState);
  }
  const ttydCommandArgs = ENABLE_TMUX_BACKEND
    ? [TMUX_BIN, 'attach-session', '-t', `${tmuxSessionName}:${TMUX_SLOT_WINDOW}`]
    : [SHELL_BIN, '-il'];

  const out = fsSync.openSync(logFileForBackend(slot.backendPort), 'a');
  const child = spawn(
    TTYD_BIN,
    [
      '-W',
      '-i',
      '127.0.0.1',
      '-p',
      String(slot.backendPort),
      '-t',
      'scrollback=100000',
      '-t',
      'disableResizeOverlay=true',
      '-t',
      `titleFixed=${slot.name}`,
      '--',
      ...ttydCommandArgs,
    ],
    {
      cwd: slotWorkdir,
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        ...runtimeEnv,
        ...(ENABLE_SHELL_HOOKS && shellConfig?.zdotdir ? { ZDOTDIR: shellConfig.zdotdir, ATC_ZDOTDIR: shellConfig.zdotdir } : {}),
        DASH_SLOT_NAME: slot.name,
        ATC_TMUX_SESSION: tmuxSessionName,
      },
    }
  );

  child.unref();
  fsSync.writeFileSync(pidFileForBackend(slot.backendPort), `${child.pid}\n`, 'utf8');
  return child.pid;
}

async function killSessionBackend(slot, stateRecord) {
  let pid = Number(stateRecord?.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    try {
      const raw = await fs.readFile(pidFileForBackend(slot.backendPort), 'utf8');
      pid = Number(raw.trim());
    } catch {
      pid = null;
    }
  }

  if (Number.isFinite(pid)) await killPid(pid);

  const portPid = await findListeningPid(slot.backendPort);
  if (Number.isFinite(portPid)) await killPid(portPid);

  try {
    await fs.unlink(pidFileForBackend(slot.backendPort));
  } catch {
    // no-op
  }

  if (ENABLE_TMUX_BACKEND) {
    const direct = await runCommand(TMUX_BIN, ['kill-session', '-t', slot.name], 3000);
    if (!direct.ok) {
      const tmuxSessionName = tmuxSessionNameForSlot(slot.name);
      if (tmuxSessionName !== slot.name) {
        await runCommand(TMUX_BIN, ['kill-session', '-t', tmuxSessionName], 3000);
      }
    }
  }
}

async function getMergedSessions() {
  const [cfg, state] = await Promise.all([readSessionsConfig(), loadState()]);
  const merged = await Promise.all(
    cfg.map(async (slot) => {
      const st = state.sessions[slot.name] || defaultSessionState(slot);
      const runtime = slotRuntimePaths(slot.name);
      if (st.status === 'active' && st.runId) {
        await recomputeDerivedForSlot(slot, st);
      }
      const [derived, tmuxPaneState] = await Promise.all([readJsonSafe(runtime.derivedFile, null), readTmuxSlotPaneState(slot.name)]);
      const active = await checkPortOpen(slot.publicPort);
      const backendActive = await checkPortOpen(slot.backendPort);
      const spawnedTs = st.spawnedAt ? new Date(st.spawnedAt).getTime() : 0;
      const inSpawnGrace = spawnedTs > 0 && Date.now() - spawnedTs < 8000;

      if (st.status === 'active' && !backendActive && !inSpawnGrace) {
        st.status = 'idle';
        st.pid = null;
        st.runId = null;
        st.spawnedAt = null;
        st.firstInteractionAt = null;
        st.lastInteractionAt = null;
        st.lastExitAt = new Date().toISOString();
      }

      const displayWorkdir = tmuxPaneState?.cwd
        || (st.status === 'active' && st.runId && derived && derived.runId === st.runId && typeof derived.cwd === 'string' && derived.cwd
          ? derived.cwd
          : st.workdir);
      const displayLastInteraction =
        st.status === 'active' && st.runId && derived && derived.runId === st.runId && typeof derived.lastInteractionAt === 'string'
          ? derived.lastInteractionAt
          : tmuxPaneState?.lastInteractionAt || st.lastInteractionAt;
      const displayActiveSince =
        st.status === 'active' && st.runId && derived && derived.runId === st.runId && typeof derived.activeSince === 'string'
          ? derived.activeSince
          : st.spawnedAt;

      return {
        ...slot,
        ...st,
        taskTitle: st.taskTitle,
        agentType:
          HOT_DIAL_BY_ID.has(st.agentType)
            ? st.agentType
            : (st.status === 'active' && st.runId && derived && derived.runId === st.runId && typeof derived.agentType === 'string'
                ? derived.agentType
                : st.agentType),
        workdir: displayWorkdir,
        activeSince: displayActiveSince || null,
        telemetry: st.status === 'active' && st.runId && derived && derived.runId === st.runId ? derived : null,
        active,
        backendActive,
        startedAgo: displayActiveSince ? durationSince(displayActiveSince) : 'n/a',
        lastInteractionAgo: displayLastInteraction ? ago(displayLastInteraction) : 'n/a',
        lastInteractionMs: displayLastInteraction ? Math.max(0, Date.now() - new Date(displayLastInteraction).getTime()) : null,
      };
    })
  );

  await saveState(state);
  return merged;
}

async function spawnSlotByName(name, options = {}) {
  const [cfg, state] = await Promise.all([readSessionsConfig(), loadState()]);
  const slot = cfg.find((s) => s.name === name);
  if (!slot) throw new Error('session not found');

  const st = state.sessions[slot.name] || defaultSessionState(slot);
  const provider = normalizeProvider(options.provider);
  const templateProvided = typeof options.templateId === 'string' && options.templateId.trim();
  const templateId = normalizeTemplateId(options.templateId, TEMPLATE_CONTINUE_WORK);
  const personaId = normalizePersonaId(options.personaId, PERSONA_NONE);
  const taskTitle = typeof options.taskTitle === 'string' && options.taskTitle.trim() ? options.taskTitle.trim() : null;
  const agentType = typeof options.agentType === 'string' && options.agentType.trim() ? options.agentType.trim() : null;
  const agentPromptFile = typeof options.agentPromptFile === 'string' && options.agentPromptFile.trim() ? options.agentPromptFile.trim() : null;
  const initialPrompt = typeof options.initialPrompt === 'string' && options.initialPrompt.trim() ? options.initialPrompt.trim() : null;
  const requestedWorkdir = typeof options.workdir === 'string' ? options.workdir : '';
  const effectiveWorkdirInput = requestedWorkdir.trim() || (templateProvided ? HOME_DIRECTORY : (st.workdir || DEFAULT_WORKDIR));
  const workdir = agentType && requestedWorkdir.trim()
    ? path.resolve(requestedWorkdir.trim())
    : await resolveWorkdirForSpawn(templateId, effectiveWorkdirInput);

  const alreadyUp = await checkPortOpen(slot.backendPort);
  if (alreadyUp) {
    st.status = 'active';
    if (!st.spawnedAt) st.spawnedAt = new Date().toISOString();
    state.sessions[slot.name] = st;
    await saveState(state);
    return;
  }

  const runId = makeRunId();
  st.provider = provider;
  st.templateId = templateId;
  st.personaId = personaId;
  st.taskTitle = taskTitle || `Fresh ${provider} session`;
  st.agentType = agentType || 'none';
  st.agentPromptFile = agentPromptFile || null;
  st.workdir = workdir;
  if (templateId === TEMPLATE_CONTINUE_WORK) appendRecentWorkdir(state, workdir);
  await rotateSlotCurrent(slot.name, st.runId);
  const { paths, hookEnv } = await ensureSlotRuntime(slot.name, runId, st.workdir, st);
  if (initialPrompt) {
    let basePrompt = '';
    if (agentPromptFile) {
      try {
        basePrompt = await fs.readFile(agentPromptFile, 'utf8');
      } catch (error) {
        throw new Error(`failed to read agent prompt file: ${error.message || 'unknown error'}`);
      }
    }
    const launchPromptPath = path.join(paths.currentDir, 'agent-launch-prompt.md');
    const launchPromptBody = basePrompt
      ? `${String(basePrompt).trimEnd()}\n\n${initialPrompt}\n`
      : `${initialPrompt}\n`;
    await fs.writeFile(launchPromptPath, launchPromptBody, 'utf8');
    st.agentPromptFile = launchPromptPath;
  }
  await emitSlotEvent(hookEnv, 'shell_start', st.workdir || DEFAULT_WORKDIR, '', '');
  const pid = await spawnSessionBackend(slot, st, { ...hookEnv }, { zdotdir: paths.zdotdir });
  const backendReady = await waitForTtydReady(slot.backendPort, 10000);
  if (!backendReady) {
    await killSessionBackend(slot, { pid });
    throw new Error(`ttyd backend ${slot.backendPort} did not become ready in time`);
  }
  const publicListenerPresent = await checkPortOpen(slot.publicPort);
  if (publicListenerPresent) {
    const publicReady = await waitForTtydReady(slot.publicPort, 10000);
    if (!publicReady) {
      await killSessionBackend(slot, { pid });
      throw new Error(`public proxy ${slot.publicPort} did not become ready in time`);
    }
  }

  st.status = 'active';
  st.pid = pid;
  st.error = null;
  st.runId = runId;
  st.spawnedAt = new Date().toISOString();
  st.firstInteractionAt = st.firstInteractionAt || st.spawnedAt;
  st.lastInteractionAt = st.spawnedAt;
  state.sessions[slot.name] = st;
  await saveState(state);
}

async function launchHotDialAgent(dialId, provider, initialPrompt = null) {
  const agent = HOT_DIAL_BY_ID.get(String(dialId || '').trim());
  if (!agent) throw new Error('unknown hot dial agent');

  const [cfg, state] = await Promise.all([readSessionsConfig(), loadState()]);
  let selectedSlot = null;
  for (const slot of cfg) {
    const st = state.sessions[slot.name] || defaultSessionState(slot);
    if (st.status === 'active') continue;
    const backendUp = await checkPortOpen(slot.backendPort);
    if (backendUp) continue;
    selectedSlot = slot;
    break;
  }

  if (!selectedSlot) throw new Error('no idle scientist slots available');

  const agentPromptFile = agent.promptFile ? path.join(PERSONAS_DIR, agent.promptFile) : null;

  await spawnSlotByName(selectedSlot.name, {
    provider: normalizeProvider(provider),
    templateId: TEMPLATE_NEW_BRAINSTORM,
    personaId: PERSONA_NONE,
    workdir: agent.workdir || HOME_DIRECTORY,
    taskTitle: agent.title,
    agentType: agent.id,
    agentPromptFile,
    initialPrompt: typeof initialPrompt === 'string' ? initialPrompt.trim() : null,
  });

  return { slotName: selectedSlot.name, agentId: agent.id };
}

async function killSlotByName(name) {
  const [cfg, state] = await Promise.all([readSessionsConfig(), loadState()]);
  const slot = cfg.find((s) => s.name === name);
  if (!slot) throw new Error('session not found');

  const st = state.sessions[slot.name] || defaultSessionState(slot);
  await killSessionBackend(slot, st);
  if (st.runId) await rotateSlotCurrent(slot.name, st.runId);

  st.status = 'idle';
  st.pid = null;
  st.runId = null;
  st.error = null;
  st.personaId = PERSONA_NONE;
  st.agentType = 'none';
  st.agentPromptFile = null;
  st.lastExitAt = new Date().toISOString();
  st.spawnedAt = null;
  st.firstInteractionAt = null;
  st.lastInteractionAt = null;
  state.sessions[slot.name] = st;
  await saveState(state);
}

async function updateSlotMeta(name, patch) {
  const [cfg, state] = await Promise.all([readSessionsConfig(), loadState()]);
  const slot = cfg.find((s) => s.name === name);
  if (!slot) throw new Error('session not found');

  const st = state.sessions[slot.name] || defaultSessionState(slot);
  if (typeof patch.taskTitle === 'string' && patch.taskTitle.trim()) st.taskTitle = patch.taskTitle.trim();
  if (typeof patch.workdir === 'string' && patch.workdir.trim()) st.workdir = patch.workdir.trim();
  if (typeof patch.agentType === 'string' && patch.agentType.trim()) st.agentType = patch.agentType.trim();
  if (typeof patch.picturePath === 'string') st.picturePath = patch.picturePath.trim();

  state.sessions[slot.name] = st;
  await saveState(state);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid json body');
  }
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function html(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function renderPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AI Traffic Control</title>
  <link rel="icon" type="image/png" href="/assets/brand/favicon-radar.png?v=1" />
  <style>${DASHBOARD_CSS}</style>
</head>
  <body>
  <div class="shell">
    <section class="title-wrap">
      <div class="title-kicker">Control Tower</div>
      <div class="title-head">
        <div class="title-mark" id="title-mark" aria-hidden="true">
          <img class="title-mark-gif" id="title-mark-gif" src="/assets/brand/title-logo.gif?v=1" alt="" />
        </div>
        <h1 class="title"><span class="accent">AI Traffic Control</span></h1>
      </div>
    </section>

    <section class="panel panel-usage">
      <div class="panel-head">
        <h2 class="panel-title">Provider Budgets</h2>
        <div class="panel-meta">Live rolling windows</div>
      </div>
      <div class="usage-stack" id="usage-grid"></div>
    </section>

    <section class="panel panel-dials">
      <div class="panel-head">
        <h2 class="panel-title">Quick Launch</h2>
        <div class="panel-meta">Hot-dial agents</div>
      </div>
      <div class="agent-dials" id="agent-dials"></div>
    </section>

    <section class="panel" style="margin-top:12px;">
      <div class="sessions" id="sessions"></div>
    </section>
  </div>

  <div class="modal-overlay" id="intent-modal">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title" id="intent-title">Start Session</div>
        <button type="button" class="modal-close" id="intent-close" aria-label="Close intent modal">&times;</button>
      </div>
      <div class="intent-top-row">
        <div class="intent-block">
          <div class="intent-label">Scientist</div>
          <div id="intent-scientist"></div>
        </div>
        <div class="intent-block">
          <div class="intent-label">Provider</div>
          <div class="provider-carousel">
            <button type="button" class="selector-nav selector-nav-left" id="provider-prev" aria-label="Previous provider">
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3L5 8l5 5"/></svg>
            </button>
            <div id="provider-select"></div>
            <button type="button" class="selector-nav selector-nav-right" id="provider-next" aria-label="Next provider">
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="intent-block">
        <div class="intent-label">Template</div>
        <div class="template-grid">
          <button type="button" class="template-btn" id="template-new" data-template="new_brainstorm">
            <div class="template-title">New brainstorm</div>
            <div class="template-subtitle">Brainstorm on a new idea</div>
          </button>
          <button type="button" class="template-btn" id="template-continue" data-template="continue_work">
            <div class="template-title">Continue work</div>
            <div class="template-subtitle">Continue WIP</div>
          </button>
        </div>
      </div>
      <div class="intent-block">
        <div class="intent-label">Persona</div>
        <div id="persona-selector"></div>
      </div>
      <div class="intent-block" id="workdir-block" style="display:none;">
        <div class="intent-label">Working Directory</div>
        <div class="workdir-row">
          <div class="workdir-path" id="workdir-path"></div>
          <button type="button" class="choose-btn" id="choose-workdir">Choose folder</button>
        </div>
        <div class="recent-workdirs">
          <div class="recent-workdirs-label">Recent Directories</div>
          <div class="recent-workdirs-list" id="recent-workdirs-list"></div>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="intent-cancel">Cancel</button>
        <button type="button" class="btn-primary" id="intent-confirm">Start session</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="dir-picker-modal">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">Select Working Directory</div>
        <button type="button" class="modal-close" id="dir-picker-close" aria-label="Close directory picker">&times;</button>
      </div>
      <div class="workdir-path" id="dir-picker-path"></div>
      <div class="picker-controls">
        <button type="button" class="btn-secondary" id="dir-picker-up">Up</button>
        <button type="button" class="btn-primary" id="dir-picker-select">Use this folder</button>
      </div>
      <div class="picker-list" id="dir-picker-list"></div>
    </div>
  </div>

  <div class="modal-overlay" id="agent-modal">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title" id="agent-title">Launch Agent</div>
        <button type="button" class="modal-close" id="agent-close" aria-label="Close agent modal">&times;</button>
      </div>
      <div class="intent-top-row">
        <div class="intent-block">
          <div class="intent-label">Agent</div>
          <div id="agent-hero"></div>
        </div>
        <div class="intent-block">
          <div class="intent-label">Provider</div>
          <div class="provider-carousel">
            <button type="button" class="selector-nav selector-nav-left" id="agent-provider-prev" aria-label="Previous provider">
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3L5 8l5 5"/></svg>
            </button>
            <div id="agent-provider-select"></div>
            <button type="button" class="selector-nav selector-nav-right" id="agent-provider-next" aria-label="Next provider">
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="intent-block">
        <div class="intent-label">Description</div>
        <div class="agent-description" id="agent-description"></div>
      </div>
      <div class="intent-block">
        <div class="intent-label">Optional first prompt</div>
        <div class="agent-prompt-hint" id="agent-prompt-hint"></div>
        <textarea class="agent-prompt-input" id="agent-initial-prompt" rows="4" placeholder="Type an optional prompt here."></textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="agent-cancel">Cancel</button>
        <button type="button" class="btn-primary" id="agent-confirm">Launch agent</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="profile-switch-modal">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">Switch Claude Account</div>
        <button type="button" class="modal-close" id="profile-switch-close" aria-label="Close account switcher">&times;</button>
      </div>
      <div class="profile-switch-subtitle">Choose an account. Cached CLI usage is shown per profile.</div>
      <div class="profile-switch-error" id="profile-switch-error" role="alert" hidden></div>
      <div class="profile-switch-list" id="profile-switch-list"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="profile-switch-cancel">Close</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="kill-modal">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">Kill Session</div>
        <button type="button" class="modal-close" id="kill-close" aria-label="Close kill confirmation">&times;</button>
      </div>
      <p class="confirm-text" id="kill-text"></p>
      <p class="confirm-text">The associated tmux session will also be killed.</p>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="kill-no">No</button>
        <button type="button" class="btn-danger" id="kill-yes">Yes, kill session</button>
      </div>
    </div>
  </div>

  <script>
    const refreshing = new Set();
    const spawning = new Set();
    const killing = new Set();
    const HOME_DIRECTORY = ${JSON.stringify(HOME_DIRECTORY)};
    const PERSONA_NONE = ${JSON.stringify(PERSONA_NONE)};
    const PERSONA_CONFIGS = ${JSON.stringify(PERSONA_CONFIGS)};
    const PERSONA_MAP = new Map(PERSONA_CONFIGS.map((persona) => [persona.id, persona]));
    const PROVIDER_ORDER = [
      { key: 'codex', title: 'Codex' },
      { key: 'claude', title: 'Claude' },
      { key: 'gemini', title: 'Gemini' },
    ];
    const HOT_DIAL_AGENTS = ${JSON.stringify(HOT_DIAL_AGENTS)};
    let latestUsage = {};
    let latestProfiles = [];
    let claudeSwitchingAlias = '';
    const profileSwitchState = { open: false };
    const intentState = {
      open: false,
      name: '',
      pictureSrc: '',
      pictureAlt: '',
      providerKey: 'codex',
      templateId: 'new_brainstorm',
      personaId: PERSONA_NONE,
      workdir: HOME_DIRECTORY,
    };
    const pickerState = {
      open: false,
      path: HOME_DIRECTORY,
      parent: null,
      directories: [],
      loading: false,
    };
    const killState = {
      open: false,
      name: '',
    };
    const agentState = {
      open: false,
      dialId: '',
      providerKey: 'codex',
      initialPrompt: '',
    };
    let latestSessionsByName = new Map();
    let sessionInteractionsBound = false;

    let bodyScrollLockDepth = 0;
    let bodyScrollLockY = 0;

    function toggleBodyScroll(locked) {
      const body = document.body;
      if (!body) return;

      if (locked) {
        bodyScrollLockDepth += 1;
        if (bodyScrollLockDepth > 1) return;
        bodyScrollLockY = window.scrollY || window.pageYOffset || 0;
        body.classList.add('modal-open');
        body.style.position = 'fixed';
        body.style.width = '100%';
        body.style.top = '-' + bodyScrollLockY + 'px';
        body.style.left = '0';
        body.style.right = '0';
        body.style.overflow = 'hidden';
        return;
      }

      if (bodyScrollLockDepth <= 0) return;
      bodyScrollLockDepth -= 1;
      if (bodyScrollLockDepth > 0) return;

      const activeEl = document.activeElement;
      if (activeEl && typeof activeEl.blur === 'function') activeEl.blur();
      const restoreY = bodyScrollLockY;
      body.classList.remove('modal-open');
      body.style.position = '';
      body.style.top = '';
      body.style.left = '';
      body.style.right = '';
      body.style.width = '';
      body.style.overflow = '';
      window.scrollTo(0, restoreY);
      requestAnimationFrame(function () {
        window.scrollTo(0, restoreY);
      });
    }

    function esc(v) {
      return String(v)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }


    function dialIconSvg(kind, klass = 'agent-dial-icon') {
      if (kind === 'calendar') {
        return '<svg class="' + esc(klass) + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
          '<rect x="3" y="5" width="18" height="16" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
          '<path d="M8 3v4M16 3v4M3 10h18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
          '</svg>';
      }
      if (kind === 'brain') {
        return '<svg class="' + esc(klass) + '" viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
          '<g fill="currentColor">' +
          '<path d="M93.998,45.312c0-3.676-1.659-7.121-4.486-9.414c0.123-0.587,0.184-1.151,0.184-1.706c0-4.579-3.386-8.382-7.785-9.037c0.101-0.526,0.149-1.042,0.149-1.556c0-4.875-3.842-8.858-8.655-9.111c-0.079-0.013-0.159-0.024-0.242-0.024c-0.04,0-0.079,0.005-0.12,0.006c-0.04-0.001-0.079-0.006-0.12-0.006c-0.458,0-0.919,0.041-1.406,0.126c-0.846-4.485-4.753-7.825-9.437-7.825c-5.311,0-9.632,4.321-9.632,9.633v65.918c0,6.723,5.469,12.191,12.191,12.191c4.46,0,8.508-2.413,10.646-6.246c0.479,0.104,0.939,0.168,1.401,0.198c2.903,0.185,5.73-0.766,7.926-2.693c2.196-1.927,3.51-4.594,3.7-7.51c0.079-1.215-0.057-2.434-0.403-3.638c3.796-2.691,6.027-6.952,6.027-11.621c0-3.385-1.219-6.635-3.445-9.224C92.731,51.505,93.998,48.471,93.998,45.312z M90.938,62.999c0,3.484-1.582,6.68-4.295,8.819c-2.008-3.196-5.57-5.237-9.427-5.237c-0.828,0-1.5,0.672-1.5,1.5s0.672,1.5,1.5,1.5c3.341,0,6.384,2.093,7.582,5.208c0.41,1.088,0.592,2.189,0.521,3.274c-0.138,2.116-1.091,4.051-2.685,5.449c-1.594,1.399-3.641,2.094-5.752,1.954c-0.594-0.039-1.208-0.167-1.933-0.402c-0.74-0.242-1.541,0.124-1.846,0.84c-1.445,3.404-4.768,5.604-8.465,5.604c-5.068,0-9.191-4.123-9.191-9.191V16.399c0-3.657,2.975-6.633,6.632-6.633c3.398,0,6.194,2.562,6.558,5.908c-2.751,1.576-4.612,4.535-4.612,7.926c0,0.829,0.672,1.5,1.5,1.5s1.5-0.671,1.5-1.5c0-3.343,2.689-6.065,6.016-6.13c3.327,0.065,6.016,2.787,6.016,6.129c0,0.622-0.117,1.266-0.359,1.971c-0.057,0.166-0.084,0.34-0.081,0.515c0.001,0.041,0.003,0.079,0.007,0.115c-0.006,0.021-0.01,0.035-0.01,0.035c-0.118,0.465-0.006,0.959,0.301,1.328c0.307,0.369,0.765,0.569,1.251,0.538c0.104-0.007,0.208-0.02,0.392-0.046c3.383,0,6.136,2.753,6.136,6.136c0,0.572-0.103,1.159-0.322,1.849c-0.203,0.635,0.038,1.328,0.591,1.7c2.434,1.639,3.909,4.329,4.014,7.242c0,0.004-0.001,0.008-0.001,0.012c0,5.03-4.092,9.123-9.122,9.123s-9.123-4.093-9.123-9.123c0-0.829-0.672-1.5-1.5-1.5s-1.5,0.671-1.5,1.5c0,6.685,5.438,12.123,12.123,12.123c2.228,0,4.31-0.615,6.106-1.668C89.88,57.539,90.938,60.212,90.938,62.999z"/>' +
          '<path d="M38.179,6.766c-4.684,0-8.59,3.34-9.435,7.825c-0.488-0.085-0.949-0.126-1.407-0.126c-0.04,0-0.079,0.005-0.12,0.006c-0.04-0.001-0.079-0.006-0.12-0.006c-0.083,0-0.163,0.011-0.242,0.024c-4.813,0.253-8.654,4.236-8.654,9.111c0,0.514,0.049,1.03,0.149,1.556c-4.399,0.655-7.785,4.458-7.785,9.037c0,0.554,0.061,1.118,0.184,1.706c-2.827,2.293-4.486,5.738-4.486,9.414c0,3.159,1.266,6.193,3.505,8.463c-2.227,2.589-3.446,5.839-3.446,9.224c0,4.669,2.231,8.929,6.027,11.621c-0.347,1.204-0.482,2.423-0.402,3.639c0.19,2.915,1.503,5.582,3.699,7.509c2.196,1.928,5.015,2.879,7.926,2.693c0.455-0.03,0.919-0.096,1.4-0.199c2.138,3.834,6.186,6.247,10.646,6.247c6.722,0,12.191-5.469,12.191-12.191V16.399C47.811,11.087,43.49,6.766,38.179,6.766z M44.811,82.317c0,5.068-4.123,9.191-9.191,9.191c-3.697,0-7.02-2.2-8.464-5.604c-0.241-0.567-0.793-0.914-1.381-0.914c-0.154,0-0.311,0.023-0.465,0.074c-0.724,0.235-1.338,0.363-1.933,0.402c-2.119,0.139-4.158-0.556-5.751-1.954c-1.594-1.398-2.547-3.333-2.685-5.449c-0.076-1.16,0.125-2.336,0.598-3.495c0.007-0.017,0.005-0.036,0.011-0.053c1.342-3.056,4.225-4.953,7.597-4.953c0.829,0,1.5-0.672,1.5-1.5s-0.671-1.5-1.5-1.5c-3.938,0-7.501,2.007-9.548,5.239c-2.701-2.139-4.277-5.327-4.277-8.802c0-2.787,1.06-5.46,2.978-7.549c1.796,1.053,3.879,1.668,6.107,1.668c6.685,0,12.123-5.438,12.123-12.123c0-0.829-0.671-1.5-1.5-1.5s-1.5,0.671-1.5,1.5c0,5.03-4.092,9.123-9.123,9.123s-9.123-4.093-9.123-9.123c0-0.002-0.001-0.004-0.001-0.006c0.103-2.915,1.578-5.607,4.013-7.248c0.553-0.372,0.793-1.064,0.591-1.699c-0.22-0.691-0.322-1.278-0.322-1.85c0-3.376,2.741-6.125,6.195-6.125c0.007,0,0.015,0,0.022,0c0.103,0.014,0.206,0.027,0.311,0.034c0.485,0.03,0.948-0.171,1.254-0.542c0.307-0.372,0.417-0.868,0.294-1.334c0-0.001-0.003-0.014-0.008-0.031c0.003-0.035,0.006-0.067,0.007-0.095c0.005-0.18-0.022-0.359-0.081-0.529c-0.242-0.707-0.359-1.352-0.359-1.972c0-3.342,2.688-6.065,6.016-6.129c3.328,0.065,6.016,2.787,6.016,6.13c0,0.829,0.671,1.5,1.5,1.5s1.5-0.671,1.5-1.5c0-3.391-1.861-6.35-4.612-7.926c0.364-3.346,3.16-5.908,6.558-5.908c3.657,0,6.632,2.976,6.632,6.633V82.317z"/>' +
          '</g>' +
          '</svg>';
      }
      return '';
    }

    const PROVIDER_LOGOS = {
      codex: '/assets/logos/openai.svg?v=2',
      claude: '/assets/logos/anthropic.svg?v=2',
      gemini: '/assets/logos/google.svg?v=2',
    };
    const usageRefreshing = new Set();
    const recentWorkdirs = [];

    function clampPct(value) {
      const pct = Number(value ?? 0);
      if (!Number.isFinite(pct)) return 0;
      return Math.max(0, Math.min(100, pct));
    }

    function pctColor(pct) {
      if (pct >= 85) return '#f96a73';
      if (pct >= 70) return '#f0bf44';
      return '#38cc89';
    }

    function compactPlan(plan) {
      const cleaned = String(plan || '').trim();
      if (!cleaned) return '';
      const lower = cleaned.toLowerCase();
      if (lower.includes('plus')) return 'Plus';
      if (lower.includes('pro')) return 'Pro';
      if (lower.includes('paid')) return 'Paid';
      return cleaned;
    }

    function compactWindowLabel(label) {
      const lower = String(label || '').toLowerCase();
      if (lower.includes('5-hour') || lower.includes('5h')) return '5H';
      if (lower.includes('weekly') || lower === 'w') return 'Weekly';
      if (lower.includes('primary')) return 'Primary';
      if (lower.includes('secondary')) return 'Secondary';
      return String(label || 'window').slice(0, 10);
    }

    function miniWindow(windowInfo) {
      if (!windowInfo) return '<div class="mini"><div class="mini-label">n/a</div><div class="mini-pct">--</div><div class="mini-bar"></div><div class="mini-reset">No data</div></div>';
      const pct = clampPct(windowInfo.usedPercent);
      const shortLabel = compactWindowLabel(windowInfo.label || 'window');
      return '<div class="mini">' +
        '<div class="mini-label">' + esc(shortLabel) + '</div>' +
        '<div class="mini-pct" style="color:' + pctColor(pct) + ';">' + esc(Math.round(pct) + '%') + '</div>' +
        '<div class="mini-bar"><div class="mini-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="mini-reset">' + esc(windowInfo.resetIn || 'n/a') + '</div>' +
      '</div>';
    }

    function winRow(windowInfo) {
      if (!windowInfo) {
        return '<div class="win missing">' +
          '<div class="win-label">n/a</div>' +
          '<div class="win-pct">--</div>' +
          '<div class="win-bar"></div>' +
          '<div class="win-reset">No data</div>' +
        '</div>';
      }
      const pct = clampPct(windowInfo.usedPercent);
      const shortLabel = compactWindowLabel(windowInfo.label || 'window');
      return '<div class="win">' +
        '<div class="win-label">' + esc(shortLabel) + '</div>' +
        '<div class="win-pct" style="color:' + pctColor(pct) + ';">' + esc(Math.round(pct) + '%') + '</div>' +
        '<div class="win-bar"><div class="win-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="win-reset">' + esc(windowInfo.resetIn || 'n/a') + '</div>' +
      '</div>';
    }

    function refreshRingButton(providerKey, title, payload) {
      const hasMeta = !!(payload && payload.nextRefreshAt);
      const refreshIntervalMs = Number(payload?.refreshIntervalMs || 0) || 30000;
      const isRefreshing = usageRefreshing.has(providerKey);
      const classes = 'refresh-ring-btn' + (isRefreshing ? ' refreshing' : '');
      const metaAttrs = hasMeta
        ? ' data-usage-refresh="1" data-provider-title="' + esc(title) + '" data-next-refresh-at="' + esc(String(payload.nextRefreshAt)) + '" data-refresh-interval-ms="' + esc(String(refreshIntervalMs)) + '"'
        : '';
      return '<button type="button" class="' + classes + '" ' +
        'data-refresh-provider="' + esc(providerKey) + '" data-provider="' + esc(providerKey) + '"' +
        metaAttrs +
        ' style="--refresh-pct: 0;" aria-label="Refresh ' + esc(title) + ' usage"' +
        (isRefreshing ? ' disabled' : '') + '>' +
        '<svg class="refresh-icon" viewBox="0 0 52 52" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<path d="M46.5,4h-3C42.7,4,42,4.7,42,5.5v7c0,0.9-0.5,1.3-1.2,0.7l0,0c-0.3-0.4-0.6-0.7-1-1c-5-5-12-7.1-19.2-5.7c-2.5,0.5-4.9,1.5-7,2.9c-6.1,4-9.6,10.5-9.7,17.5c-0.1,5.4,2,10.8,5.8,14.7c4,4.2,9.4,6.5,15.2,6.5c5.1,0,9.9-1.8,13.7-5c0.7-0.6,0.7-1.6,0.1-2.2l-2.1-2.1c-0.5-0.5-1.4-0.6-2-0.1c-3.6,3-8.5,4.2-13.4,3c-1.3-0.3-2.6-0.9-3.8-1.6C11.7,36.6,9,30,10.6,23.4c0.3-1.3,0.9-2.6,1.6-3.8C15,14.7,19.9,12,25.1,12c4,0,7.8,1.6,10.6,4.4c0.5,0.4,0.9,0.9,1.2,1.4c0.3,0.8-0.4,1.2-1.3,1.2h-7c-0.8,0-1.5,0.7-1.5,1.5v3.1c0,0.8,0.6,1.4,1.4,1.4h18.3c0.7,0,1.3-0.6,1.3-1.3V5.5C48,4.7,47.3,4,46.5,4z"/>' +
        '</svg>' +
        '<svg class="refresh-spinner" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<circle cx="14" cy="14" r="11" stroke="currentColor" stroke-width="2.5" stroke-dasharray="17" stroke-linecap="round" opacity="0.8"/>' +
        '</svg>' +
      '</button>';
    }

    function cardHead(providerKey, title, logo, planPill, aliasPill, extraActions, payload) {
      return '<div class="card-head">' +
        '<img class="card-logo" src="' + esc(logo) + '" alt="' + esc(title) + ' logo" loading="lazy" width="40" height="40" />' +
        '<div class="card-ident">' +
          '<div class="card-title-row">' +
            '<div class="card-name">' + esc(title) + '</div>' +
            planPill +
            aliasPill +
          '</div>' +
        '</div>' +
        '<div class="card-actions">' +
          extraActions +
          refreshRingButton(providerKey, title, payload) +
        '</div>' +
      '</div>';
    }

    function providerUsageRow(providerKey, title, payload, activeProfile, allProfiles) {
      const logo = PROVIDER_LOGOS[providerKey] || '';
      const hasProfiles = providerKey === 'claude' && Array.isArray(allProfiles) && allProfiles.length > 1;
      const isProfileSwitching = providerKey === 'claude' && !!claudeSwitchingAlias;
      const shownActiveProfile = isProfileSwitching ? claudeSwitchingAlias : activeProfile;
      const switchBtn = hasProfiles
        ? '<button type="button" class="switch-btn" data-open-profile-switch="1" aria-label="Switch Claude account">Switch</button>'
        : '';
      const aliasPill = providerKey === 'claude' && shownActiveProfile
        ? '<div class="card-alias">' + esc(String(shownActiveProfile)) + '</div>'
        : '';

      if (payload && payload.loading) {
        const planPill = '<div class="card-plan">Loading</div>';
        return '<article class="usage-row loading" data-provider="' + esc(providerKey) + '">' +
          cardHead(providerKey, title, logo, planPill, aliasPill, switchBtn, payload) +
          '<div class="usage-loading"><span class="usage-spinner" aria-hidden="true"></span><span>Loading usage…</span></div>' +
        '</article>';
      }
      if (!payload || !payload.ok) {
        const planPill = '<div class="card-plan">Unavailable</div>';
        return '<article class="usage-row error" data-provider="' + esc(providerKey) + '">' +
          cardHead(providerKey, title, logo, planPill, aliasPill, switchBtn, payload) +
          '<div class="usage-error">' + esc(payload?.error || 'Usage unavailable') + '</div>' +
        '</article>';
      }

      const activeProfileMeta =
        providerKey === 'claude' && Array.isArray(allProfiles)
          ? allProfiles.find(function (p) { return String(p?.alias || '') === String(shownActiveProfile || ''); })
          : null;
      const profileSubscription = String(activeProfileMeta?.subscriptionType || '').trim();
      const plan = compactPlan(payload.plan || (providerKey === 'claude' ? (profileSubscription || 'Pro') : 'connected'));
      const planPill = '<div class="card-plan">' + esc(plan) + '</div>';

      return '<article class="usage-row' + (isProfileSwitching ? ' switching' : '') + '" data-provider="' + esc(providerKey) + '">' +
        cardHead(providerKey, title, logo, planPill, aliasPill, switchBtn, payload) +
        (isProfileSwitching
          ? '<div class="usage-switching-note"><span class="usage-spinner" aria-hidden="true"></span><span>Switching to ' + esc(claudeSwitchingAlias) + '…</span></div>'
          : '') +
        '<div class="windows">' +
          winRow(payload.primary) +
          winRow(payload.secondary) +
        '</div>' +
      '</article>';
    }

    function bindUsageInteractions() {
      const switchButtons = document.querySelectorAll('[data-open-profile-switch]');
      for (const btn of switchButtons) {
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          openProfileSwitchModal();
        });
      }
      const refreshButtons = document.querySelectorAll('[data-refresh-provider]');
      for (const btn of refreshButtons) {
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (btn.disabled) return;
          const provider = btn.getAttribute('data-refresh-provider');
          if (!provider) return;
          manualRefreshProvider(provider);
        });
      }
    }

    let usageRefreshTicker = null;
    let usageAutoRefreshInFlight = false;
    const providerAutoRefreshAt = new Map();
    function formatMmSs(totalSeconds) {
      const sec = Math.max(0, Number(totalSeconds) || 0);
      const minPart = Math.floor(sec / 60);
      const secPart = sec % 60;
      return String(minPart).padStart(2, '0') + ':' + String(secPart).padStart(2, '0');
    }

    function tickUsageRefreshCountdown() {
      const refreshEls = document.querySelectorAll('[data-usage-refresh]');
      for (const el of refreshEls) {
        const providerKey = String(el.getAttribute('data-provider') || '').toLowerCase();
        const nextIso = el.getAttribute('data-next-refresh-at') || '';
        const intervalMs = Number(el.getAttribute('data-refresh-interval-ms') || 0) || 30000;
        const nextMs = Date.parse(nextIso);
        if (!Number.isFinite(nextMs)) continue;
        const remainingMs = Math.max(0, nextMs - Date.now());
        const remainingSec = Math.ceil(remainingMs / 1000);
        const pct = Math.max(0, Math.min(100, ((intervalMs - remainingMs) / intervalMs) * 100));
        el.style.setProperty('--refresh-pct', String(pct));
        if (remainingSec <= 0 && providerKey) {
          const nowMs = Date.now();
          const lastKickoffMs = Number(providerAutoRefreshAt.get(providerKey) || 0);
          if (!usageAutoRefreshInFlight && nowMs - lastKickoffMs >= 1500) {
            providerAutoRefreshAt.set(providerKey, nowMs);
            usageAutoRefreshInFlight = true;
            usageRefreshing.add(providerKey);
            renderUsageGrid(latestUsage);
            (async function () {
              try {
                try {
                  await fetch('/api/usage/refresh', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ provider: providerKey, force: false }),
                  });
                } catch (_e) {
                  // ignore, fall through to snapshot refresh
                }
                await refresh();
              } finally {
                usageAutoRefreshInFlight = false;
                usageRefreshing.delete(providerKey);
                renderUsageGrid(latestUsage);
              }
            })();
          }
        }
      }
    }

    function bindUsageRefreshTicker() {
      if (usageRefreshTicker) clearInterval(usageRefreshTicker);
      tickUsageRefreshCountdown();
      usageRefreshTicker = setInterval(tickUsageRefreshCountdown, 1000);
    }

    function formatShortAge(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '';
      const sec = Math.round(ms / 1000);
      if (sec < 60) return sec + 's';
      const min = Math.round(sec / 60);
      if (min < 60) return min + 'm';
      const hr = Math.round(min / 60);
      if (hr < 48) return hr + 'h';
      const day = Math.round(hr / 24);
      return day + 'd';
    }

    function stalenessBadge(staleness, isActive) {
      if (!staleness || typeof staleness !== 'object') return '';
      const level = String(staleness.stalenessLevel || 'fresh');
      const age = formatShortAge(staleness.lastSyncAgeMs);
      if (isActive) {
        // Active profile: only surface if sync is lagging (would imply the
        // dashboard lost its keychain read loop).
        if (level === 'fresh') {
          return '<div class="profile-staleness ok">synced ' + esc(age) + ' ago</div>';
        }
        const label = level === 'critical' ? 'sync stalled' : 'sync lagging';
        return '<div class="profile-staleness ' + level + '">⚠ ' + label + ' — last ' + esc(age) + ' ago</div>';
      }
      // Inactive profile: surface age when moderate, warn loudly near RT lifetime.
      if (level === 'fresh') {
        return '<div class="profile-staleness dim">last active ' + esc(age) + ' ago</div>';
      }
      if (level === 'warn') {
        return '<div class="profile-staleness warn">last active ' + esc(age) + ' ago</div>';
      }
      return '<div class="profile-staleness critical">⚠ last active ' + esc(age) + ' ago — re-login likely needed</div>';
    }

    function recoveryBadge(profile) {
      if (!profile || !profile.needsRecovery) return '';
      const cooldown = profile.refreshCooldown;
      const msg = cooldown && cooldown.remainingMs > 0
        ? 'rate-limited — rotate needed (' + formatShortAge(cooldown.remainingMs) + ' cooldown)'
        : 'refresh failed — rotate needed';
      return '<div class="profile-staleness critical">⚠ ' + esc(msg) + '</div>';
    }

    function profileUsageCard(profile, activeAlias) {
      const usage = profile && profile.usageCache && typeof profile.usageCache === 'object' ? profile.usageCache : {};
      const alias = String(profile?.alias || '').trim();
      const isActive = alias && alias === activeAlias;
      const isSwitchingTo = !!claudeSwitchingAlias && alias === claudeSwitchingAlias;
      const cachedEmail = String(usage.accountEmail || profile?.email || '').trim();
      const needsRecovery = !!profile?.needsRecovery;
      const statusLabel = isSwitchingTo ? 'Switching…' : (needsRecovery ? 'Recover' : (isActive ? 'Active' : 'Switch'));
      return '<button type="button" class="profile-switch-card ' + (isActive ? 'active' : '') + (needsRecovery ? ' needs-recovery' : '') + '" data-profile-alias="' + esc(alias) + '" ' +
        (isSwitchingTo ? 'disabled' : '') +
        (needsRecovery && profile?.recoveryCommand ? ' title="' + esc('Run: ' + profile.recoveryCommand) + '"' : '') +
        '>' +
        '<div class="profile-switch-head">' +
          '<div class="profile-switch-name">' + esc(profile?.displayName || alias || 'Profile') + '</div>' +
          '<div class="profile-switch-status">' + statusLabel + '</div>' +
        '</div>' +
        '<div class="profile-switch-email">' + esc(cachedEmail || 'n/a') + '</div>' +
        '<div class="profile-switch-windows">' +
          miniWindow(usage.primary || null) +
          miniWindow(usage.secondary || null) +
        '</div>' +
        recoveryBadge(profile) +
        stalenessBadge(profile?.credStaleness, isActive) +
      '</button>';
    }

    function renderProfileSwitchModal() {
      const host = document.getElementById('profile-switch-list');
      if (!host) return;
      if (!Array.isArray(latestProfiles) || !latestProfiles.length) {
        host.innerHTML = '<div class="line muted">No Claude accounts registered.</div>';
        return;
      }
      host.innerHTML = latestProfiles.map(function (profile) {
        return profileUsageCard(profile, latestUsage?.activeProfile || null);
      }).join('');
      const cards = host.querySelectorAll('[data-profile-alias]');
      for (const card of cards) {
        card.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          const alias = card.getAttribute('data-profile-alias');
          if (!alias) return;
          switchProfileTo(alias);
        });
      }
    }

    function openProfileSwitchModal() {
      clearProfileSwitchError();
      renderProfileSwitchModal();
      const modal = document.getElementById('profile-switch-modal');
      if (modal) modal.classList.add('open');
      profileSwitchState.open = true;
      toggleBodyScroll(true);
    }

    function showProfileSwitchError(message) {
      const el = document.getElementById('profile-switch-error');
      if (!el) return;
      const text = String(message || '').trim() || 'Switch failed.';
      el.textContent = text;
      el.hidden = false;
    }

    function clearProfileSwitchError() {
      const el = document.getElementById('profile-switch-error');
      if (!el) return;
      el.textContent = '';
      el.hidden = true;
    }

    function summarizeSwitchError(raw) {
      const text = String(raw || '').trim();
      if (!text) return 'Switch failed.';
      // atc-profile surfaces multi-line Anthropic/codexbar output. Pick the
      // first non-Warning line so the toast reads as an actionable reason
      // rather than leading with "Warning: ...".
      for (const line of text.split(/\\r?\\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.toLowerCase().startsWith('warning:')) continue;
        return trimmed.length > 180 ? trimmed.slice(0, 179) + '…' : trimmed;
      }
      const first = text.split(/\\r?\\n/)[0].trim();
      return first.length > 180 ? first.slice(0, 179) + '…' : (first || 'Switch failed.');
    }

    function closeProfileSwitchModal() {
      const modal = document.getElementById('profile-switch-modal');
      if (modal) modal.classList.remove('open');
      profileSwitchState.open = false;
      toggleBodyScroll(false);
    }

    function targetProfileCache(alias) {
      if (!alias || !Array.isArray(latestProfiles)) return null;
      const match = latestProfiles.find(function (p) { return p && p.alias === alias; });
      const cache = match && match.usageCache && typeof match.usageCache === 'object' ? match.usageCache : null;
      return cache;
    }

    let postSwitchPollTimer = null;
    function startPostSwitchReconcilePoll(alias, switchStartedAt) {
      if (postSwitchPollTimer) {
        clearTimeout(postSwitchPollTimer);
        postSwitchPollTimer = null;
      }
      let attempts = 0;
      const intervalMs = 2000;
      const maxAttempts = 90;
      const tick = async function () {
        attempts += 1;
        try {
          const [usageResp, profilesResp] = await Promise.all([
            fetch('/api/usage', { cache: 'no-store' }),
            fetch('/api/profiles', { cache: 'no-store' }),
          ]);
          let usage = null;
          if (usageResp.ok) {
            try { usage = await usageResp.json(); } catch (_e) { usage = null; }
          }
          if (profilesResp.ok) {
            try {
              const profilesPayload = await profilesResp.json();
              if (profilesPayload && Array.isArray(profilesPayload.profiles)) {
                latestProfiles = profilesPayload.profiles;
              }
            } catch (_e) {}
          }
          if (usage && typeof usage === 'object') {
            const isFresh = usage.fetchedAt ? Date.parse(usage.fetchedAt) > switchStartedAt : false;
            const profileMatches = usage.activeProfile === alias;
            const claudeReady = usage.claude && !usage.claude.loading;
            if (isFresh && profileMatches && claudeReady) {
              renderUsageGrid(usage);
              postSwitchPollTimer = null;
              return;
            }
          }
        } catch (_error) {}
        if (attempts >= maxAttempts) {
          postSwitchPollTimer = null;
          return;
        }
        postSwitchPollTimer = setTimeout(tick, intervalMs);
      };
      postSwitchPollTimer = setTimeout(tick, intervalMs);
    }

    async function switchProfileTo(alias) {
      if (!alias || claudeSwitchingAlias) return;
      const prevUsage = latestUsage;
      claudeSwitchingAlias = alias;
      clearProfileSwitchError();
      const targetCache = targetProfileCache(alias);
      latestUsage = {
        ...(latestUsage || {}),
        activeProfile: alias,
        ...(targetCache ? { claude: targetCache } : {}),
      };
      renderUsageGrid(latestUsage);
      renderProfileSwitchModal();
      const switchStartedAt = Date.now();
      try {
        const resp = await fetch('/api/profiles/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alias }),
        });
        if (!resp.ok) {
          let errorBody = null;
          try { errorBody = await resp.json(); } catch (_e) { errorBody = null; }
          claudeSwitchingAlias = '';
          latestUsage = prevUsage;
          renderUsageGrid(latestUsage);
          renderProfileSwitchModal();
          showProfileSwitchError(summarizeSwitchError(errorBody?.error));
          return;
        }
        await pollUsageUntilProfileActive({
          targetAlias: alias,
          switchStartedAt,
          maxAttempts: 80,
          pollIntervalMs: 200,
          wallClockTimeoutMs: 16000,
          fetchUsageUrl: '/api/usage',
          fetchProfilesUrl: '/api/profiles',
          onUsageUpdate: function (usage) {
            if (claudeSwitchingAlias && usage && typeof usage === 'object') {
              for (const key of ['codex', 'gemini']) {
                if (usage[key]?.loading && latestUsage?.[key]) usage[key] = latestUsage[key];
              }
              // Hold the target profile's cached Claude numbers visible while
              // the background refresh is still running — otherwise a poll tick
              // that reads a loading/null claude snapshot would flicker the card
              // back to a spinner between the optimistic pre-render and onComplete.
              if (usage.claude?.loading && targetCache) usage.claude = targetCache;
            }
          },
          onComplete: function (data) {
            claudeSwitchingAlias = '';
            renderUsageGrid(data.usage || {});
            if (data.profiles && Array.isArray(data.profiles)) {
              latestProfiles = data.profiles;
            }
            renderProfileSwitchModal();
            closeProfileSwitchModal();
          },
          onTimeout: function () {
            // Backend force-refresh didn't land inside the 16s wall-clock
            // budget (codexbar OAuth + web + CLI fallbacks can exceed it on
            // rate-limited accounts). Leave the optimistic cached render in
            // place, close the modal, and keep polling in the background so
            // the card swaps to live numbers without a manual refresh.
            claudeSwitchingAlias = '';
            renderUsageGrid(latestUsage);
            renderProfileSwitchModal();
            closeProfileSwitchModal();
            startPostSwitchReconcilePoll(alias, switchStartedAt);
          },
        });
      } catch (error) {
        claudeSwitchingAlias = '';
        latestUsage = prevUsage;
        renderUsageGrid(latestUsage);
        renderProfileSwitchModal();
        showProfileSwitchError(summarizeSwitchError(error?.message));
      }
    }

    async function manualRefreshProvider(provider) {
      const providerKey = String(provider || '').toLowerCase();
      if (!providerKey) return;
      if (usageRefreshing.has(providerKey)) return;
      usageRefreshing.add(providerKey);
      renderUsageGrid(latestUsage);
      try {
        try {
          await fetch('/api/usage/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: providerKey, force: true }),
          });
        } catch (_error) {
          // ignore and fall through to refresh current snapshot
        }
        await refresh();
      } finally {
        usageRefreshing.delete(providerKey);
        renderUsageGrid(latestUsage);
      }
    }

    function compact(v, max) {
      const cleaned = String(v || '').replace(/\\s+/g, ' ').trim();
      if (!cleaned) return '';
      if (cleaned.length <= max) return cleaned;
      return cleaned.slice(0, max - 1) + '…';
    }

    function normalizePersonaId(personaId) {
      const raw = String(personaId || '').trim().toLowerCase();
      if (!raw) return PERSONA_NONE;
      const canonical = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      return PERSONA_MAP.has(canonical) ? canonical : PERSONA_NONE;
    }

    function personaForId(personaId) {
      return PERSONA_MAP.get(normalizePersonaId(personaId)) || PERSONA_MAP.get(PERSONA_NONE);
    }

    function sessionPictureSrc(session) {
      const raw = String(session && session.picturePath ? session.picturePath : '').trim();
      if (!raw) return '';
      if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
      let cleaned = raw;
      while (cleaned.startsWith('/')) cleaned = cleaned.slice(1);
      if (cleaned.startsWith('assets/')) return '/' + cleaned;
      return '/assets/' + cleaned;
    }

    function personaIdsForTemplate(templateId) {
      if (templateId === '${TEMPLATE_NEW_BRAINSTORM}') return [PERSONA_NONE, 'brainstormer'];
      if (templateId === '${TEMPLATE_CONTINUE_WORK}') return [PERSONA_NONE, 'refactor', 'tester', 'reviewer', 'slot_machine_bandit', 'documenter'];
      return [PERSONA_NONE];
    }

    function normalizePersonaForTemplate(personaId, templateId) {
      const allowed = personaIdsForTemplate(templateId);
      const normalized = normalizePersonaId(personaId);
      return allowed.includes(normalized) ? normalized : allowed[0] || PERSONA_NONE;
    }

    function selectedScientistName() {
      return String(intentState.name || 'Scientist').trim() || 'Scientist';
    }

    function personaHatMarkup(persona, variant = 'intent') {
      if (!persona || persona.id === PERSONA_NONE) return '';
      if (persona.hatStyle !== 'rainbow' && !persona.hatColor) return '';
      const fill = persona.hatStyle === 'rainbow' ? 'url(#persona-rainbow-hat)' : esc(persona.hatColor || persona.accent || '#dbe8ff');
      const stroke = persona.hatStyle === 'rainbow' ? '#18213a' : '#0b1324';
      const klass = variant === 'session' ? 'session-persona-hat' : 'intent-scientist-hat';
      const body = persona.hatStyle === 'rainbow'
        ? '<defs><linearGradient id="persona-rainbow-hat" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#f43f5e"/><stop offset="16%" stop-color="#fb923c"/><stop offset="32%" stop-color="#facc15"/><stop offset="48%" stop-color="#4ade80"/><stop offset="64%" stop-color="#22d3ee"/><stop offset="80%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#c084fc"/></linearGradient></defs>'
        : '';
      return '<svg class="' + klass + '" viewBox="0 0 120 80" aria-hidden="true" focusable="false">' +
        body +
        '<path d="M16 54h88c5.5 0 10 4.5 10 10v3H6v-3c0-5.5 4.5-10 10-10z" fill="' + fill + '" stroke="' + stroke + '" stroke-width="2" stroke-linejoin="round"/>' +
        '<path d="M34 15h52c8 0 14 6 14 14v25H20V29c0-8 6-14 14-14z" fill="' + fill + '" stroke="' + stroke + '" stroke-width="2" stroke-linejoin="round"/>' +
        '<path d="M24 41h72c8 0 14 5 14 11v2H10v-2c0-6 6-11 14-11z" fill="rgba(255,255,255,0.16)"/>' +
      '</svg>';
    }

    function renderScientistHero() {
      const src = String(intentState.pictureSrc || '').trim();
      const alt = String(intentState.pictureAlt || selectedScientistName() + ' portrait').trim();
      const name = selectedScientistName();
      const persona = personaForId(intentState.personaId);
      const hat = personaHatMarkup(persona, 'intent');
      if (src) {
        return '<div class="intent-scientist">' +
          '<img class="intent-scientist-image" src="' + esc(src) + '" alt="' + esc(alt) + '" loading="lazy" decoding="async" />' +
          hat +
          '<div class="intent-scientist-overlay">' + esc(name) + '</div>' +
        '</div>';
      }
      return '<div class="intent-scientist intent-scientist-fallback" aria-label="' + esc(alt) + '">' +
        hat +
        esc(name.slice(0, 1).toUpperCase()) +
      '</div>';
    }

    function allowedPersonaList() {
      return personaIdsForTemplate(intentState.templateId)
        .map((id) => PERSONA_MAP.get(id))
        .filter(Boolean);
    }

    function personaCard(persona, active) {
      return '<button type="button" class="persona-select-card ' + (active ? 'active' : '') + '" data-persona-id="' + esc(persona.id) + '" aria-pressed="' + (active ? 'true' : 'false') + '" style="--persona-accent:' + esc(persona.accent) + '">' +
        '<div class="persona-select-head">' +
          '<span class="persona-select-dot" aria-hidden="true"></span>' +
          '<div class="persona-select-name">' + esc(persona.label) + '</div>' +
        '</div>' +
        '<div class="persona-select-desc">' + esc(persona.description) + '</div>' +
      '</button>';
    }

    function renderPersonaSelector() {
      const personas = allowedPersonaList();
      const activeId = normalizePersonaForTemplate(intentState.personaId, intentState.templateId);
      return '<div class="persona-carousel">' +
        '<button type="button" class="selector-nav selector-nav-left" id="persona-prev" aria-label="Previous persona">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3L5 8l5 5"/></svg>' +
        '</button>' +
        '<div id="persona-select-card">' +
          personaCard(PERSONA_MAP.get(activeId) || PERSONA_MAP.get(PERSONA_NONE), true) +
        '</div>' +
        '<button type="button" class="selector-nav selector-nav-right" id="persona-next" aria-label="Next persona">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="persona-note">' +
        (personas.length > 1
          ? 'Swipe or use arrows to switch personas for this template.'
          : 'Only the vanilla persona is available for this template.') +
        ' Selected at start only. Changing persona later means killing and respawning the session.' +
      '</div>';
    }

    function personaBadge(personaId) {
      const persona = personaForId(personaId);
      if (!persona || persona.id === PERSONA_NONE) return '';
      return '<span class="persona-badge" data-persona-badge="1" style="--persona-accent:' + esc(persona.accent) + '">' + esc(persona.label) + '</span>';
    }

    function hotDialById(dialId) {
      return HOT_DIAL_AGENTS.find((agent) => agent.id === dialId) || null;
    }

    function hotDialCard(agent) {
      const icon = dialIconSvg(agent.icon);
      const glyph = icon || '<span class="agent-dial-emoji">' + esc(agent.emoji || '✨') + '</span>';
      if (!agent.enabled) {
        return '<div class="agent-dial-card agent-dial-placeholder" title="' + esc(agent.description || '') + '">' +
          glyph +
          '<div class="agent-dial-title">' + esc(agent.title || 'Coming Soon') + '</div>' +
        '</div>';
      }
      return '<button type="button" class="agent-dial-card" data-agent-dial-id="' + esc(agent.id) + '" title="' + esc(agent.description || '') + '">' +
        glyph +
        '<div class="agent-dial-title">' + esc(agent.title || 'Agent') + '</div>' +
      '</button>';
    }

    function renderHotDials() {
      const host = document.getElementById('agent-dials');
      if (!host) return;
      const next = HOT_DIAL_AGENTS.map(hotDialCard).join('');
      if (host.innerHTML !== next) {
        host.innerHTML = next;
        bindHotDialInteractions();
      }
    }

    function hostForPort(port) {
      return window.location.protocol + '//' + window.location.hostname + ':' + port;
    }

    function connectUrlForPort(port) {
      const base = hostForPort(port);
      const sep = base.includes('?') ? '&' : '?';
      return base + sep + 'atc_connect=' + Date.now();
    }

    function focusSessionCard(name, behavior = 'auto') {
      if (!name) return;
      const selector = '.session.tap[data-name="' + CSS.escape(String(name)) + '"]';
      const scrollToCard = function () {
        const card = document.querySelector(selector);
        if (!card || typeof card.scrollIntoView !== 'function') return false;
        card.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
        return true;
      };
      if (scrollToCard()) return;
      requestAnimationFrame(scrollToCard);
    }

    async function apiPost(path, payload) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || ('request failed: ' + res.status));
      return body;
    }

    async function apiGet(path) {
      const res = await fetch(path, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || ('request failed: ' + res.status));
      return body;
    }

    function openIntentModal(name, pictureSrc = '') {
      intentState.open = true;
      intentState.name = name;
      intentState.pictureSrc = pictureSrc || '';
      intentState.pictureAlt = name ? (name + ' portrait') : '';
      intentState.providerKey = 'codex';
      intentState.templateId = 'new_brainstorm';
      intentState.personaId = PERSONA_NONE;
      intentState.workdir = HOME_DIRECTORY;
      renderIntentModal();
      const modal = document.getElementById('intent-modal');
      if (modal) modal.classList.add('open');
      toggleBodyScroll(true);
    }

    function closeIntentModal() {
      intentState.open = false;
      intentState.pictureSrc = '';
      intentState.pictureAlt = '';
      const modal = document.getElementById('intent-modal');
      if (modal) modal.classList.remove('open');
      if (!pickerState.open && !killState.open && !agentState.open) {
        toggleBodyScroll(false);
      }
    }

    function openAgentModal(dialId) {
      const agent = hotDialById(dialId);
      if (!agent || !agent.enabled) return;
      agentState.open = true;
      agentState.dialId = agent.id;
      agentState.providerKey = 'codex';
      agentState.initialPrompt = '';
      renderAgentModal();
      const modal = document.getElementById('agent-modal');
      if (modal) modal.classList.add('open');
      toggleBodyScroll(true);
    }

    function closeAgentModal() {
      agentState.open = false;
      agentState.dialId = '';
      agentState.initialPrompt = '';
      const modal = document.getElementById('agent-modal');
      if (modal) modal.classList.remove('open');
      if (!intentState.open && !pickerState.open && !killState.open) toggleBodyScroll(false);
    }

    function openDirPicker() {
      pickerState.open = true;
      pickerState.path = intentState.workdir || HOME_DIRECTORY;
      const modal = document.getElementById('dir-picker-modal');
      if (modal) modal.classList.add('open');
      loadDirectory(pickerState.path).catch((err) => {
        alert('Failed to list directories: ' + err.message);
      });
      toggleBodyScroll(true);
    }

    function closeDirPicker() {
      pickerState.open = false;
      const modal = document.getElementById('dir-picker-modal');
      if (modal) modal.classList.remove('open');
      if (!intentState.open && !killState.open && !agentState.open) toggleBodyScroll(false);
    }

    function openKillModal(name) {
      killState.open = true;
      killState.name = name;
      const text = document.getElementById('kill-text');
      if (text) text.textContent = 'Are you sure you want to kill the session ' + name + '?';
      const modal = document.getElementById('kill-modal');
      if (modal) modal.classList.add('open');
      toggleBodyScroll(true);
    }

    function closeKillModal() {
      killState.open = false;
      killState.name = '';
      const modal = document.getElementById('kill-modal');
      if (modal) modal.classList.remove('open');
      if (!intentState.open && !pickerState.open && !agentState.open) toggleBodyScroll(false);
    }

    function activeProviderIndex() {
      const idx = PROVIDER_ORDER.findIndex((p) => p.key === intentState.providerKey);
      return idx >= 0 ? idx : 0;
    }

    function rotateProvider(direction) {
      const idx = activeProviderIndex();
      const next = (idx + direction + PROVIDER_ORDER.length) % PROVIDER_ORDER.length;
      intentState.providerKey = PROVIDER_ORDER[next].key;
      renderIntentModal();
    }

    function activeAgentProviderIndex() {
      const idx = PROVIDER_ORDER.findIndex((p) => p.key === agentState.providerKey);
      return idx >= 0 ? idx : 0;
    }

    function rotateAgentProvider(direction) {
      const idx = activeAgentProviderIndex();
      const next = (idx + direction + PROVIDER_ORDER.length) % PROVIDER_ORDER.length;
      agentState.providerKey = PROVIDER_ORDER[next].key;
      renderAgentModal();
    }

    function activePersonaIndex() {
      const personas = allowedPersonaList();
      const activeId = normalizePersonaForTemplate(intentState.personaId, intentState.templateId);
      const idx = personas.findIndex((persona) => persona.id === activeId);
      return idx >= 0 ? idx : 0;
    }

    function rotatePersona(direction) {
      const personas = allowedPersonaList();
      if (!personas.length) return;
      const idx = activePersonaIndex();
      const next = (idx + direction + personas.length) % personas.length;
      intentState.personaId = personas[next].id;
      renderIntentModal();
    }

    function providerSelectionCard(provider, cardId = 'provider-select-card') {
      const logo = PROVIDER_LOGOS[provider.key] || '';
      const usage = latestUsage ? latestUsage[provider.key] : null;
      if (!usage || !usage.ok) {
        return '<div class="provider-select-card" id="' + esc(cardId) + '">' +
          '<div class="provider-select-head">' +
            '<img class="provider-select-logo" src="' + esc(logo) + '" alt="' + esc(provider.title) + ' logo" loading="lazy" width="56" height="56" />' +
            '<div><div class="provider-select-name">' + esc(provider.title) + '</div><div class="provider-select-plan">Usage unavailable</div></div>' +
          '</div>' +
          '<div class="provider-select-windows">' + miniWindow(null) + miniWindow(null) + '</div>' +
        '</div>';
      }
      const plan = compactPlan(usage.plan || 'connected');
      return '<div class="provider-select-card" id="' + esc(cardId) + '">' +
        '<div class="provider-select-head">' +
          '<img class="provider-select-logo" src="' + esc(logo) + '" alt="' + esc(provider.title) + ' logo" loading="lazy" width="56" height="56" />' +
          '<div><div class="provider-select-name">' + esc(provider.title) + '</div><div class="provider-select-plan">' + esc(plan) + '</div></div>' +
        '</div>' +
        '<div class="provider-select-windows">' +
          miniWindow(usage.primary) +
          miniWindow(usage.secondary) +
        '</div>' +
      '</div>';
    }

    function renderIntentModal() {
      const title = document.getElementById('intent-title');
      if (title) title.textContent = intentState.name ? ('Start ' + intentState.name) : 'Start Session';

      intentState.personaId = normalizePersonaForTemplate(intentState.personaId, intentState.templateId);

      const selectedProvider = PROVIDER_ORDER[activeProviderIndex()];
      const providerHost = document.getElementById('provider-select');
      if (providerHost) providerHost.innerHTML = providerSelectionCard(selectedProvider, 'provider-select-card');

      const scientistHost = document.getElementById('intent-scientist');
      if (scientistHost) scientistHost.innerHTML = renderScientistHero();

      const templateButtons = document.querySelectorAll('[data-template]');
      for (const btn of templateButtons) {
        const template = btn.getAttribute('data-template');
        btn.classList.toggle('active', template === intentState.templateId);
      }

      const personaHost = document.getElementById('persona-selector');
      if (personaHost) personaHost.innerHTML = renderPersonaSelector();

      const workdirBlock = document.getElementById('workdir-block');
      const workdirPath = document.getElementById('workdir-path');
      const recentList = document.getElementById('recent-workdirs-list');
      const continueWork = intentState.templateId === 'continue_work';
      if (workdirBlock) workdirBlock.style.display = continueWork ? 'block' : 'none';
      if (workdirPath) workdirPath.textContent = intentState.workdir || HOME_DIRECTORY;
      if (recentList) {
        if (!recentWorkdirs.length) {
          recentList.innerHTML = '<p class="recent-workdirs-empty">No recent directories yet.</p>';
        } else {
          recentList.innerHTML = recentWorkdirs
            .slice(0, 5)
            .map((entry) => {
              const active = entry === intentState.workdir;
              return '<button type="button" class="recent-workdir-btn ' + (active ? 'active' : '') + '" data-recent-workdir="' + esc(entry) + '">' + esc(entry) + '</button>';
            })
            .join('');
        }
      }

      bindIntentModalInteractions();
      bindProviderSwipeCard('provider-select-card', rotateProvider);
    }

    function renderAgentModal() {
      const agent = hotDialById(agentState.dialId);
      if (!agent) return;

      const title = document.getElementById('agent-title');
      if (title) title.textContent = 'Launch ' + agent.title;

      const hero = document.getElementById('agent-hero');
      if (hero) {
        const icon = dialIconSvg(agent.icon, 'agent-card-icon');
        const glyph = icon || '<span class="agent-card-emoji">' + esc(agent.emoji || '✨') + '</span>';
        hero.innerHTML = '<div class="agent-card">' +
          glyph +
          '<div class="agent-card-title">' + esc(agent.title) + '</div>' +
        '</div>';
      }

      const description = document.getElementById('agent-description');
      if (description) description.textContent = agent.description || '';

      const promptHint = document.getElementById('agent-prompt-hint');
      if (promptHint) promptHint.textContent = agent.promptHint || 'Type an optional prompt here.';

      const promptInput = document.getElementById('agent-initial-prompt');
      if (promptInput) {
        promptInput.placeholder = agent.promptPlaceholder || 'Type an optional prompt here.';
        if (promptInput.value !== agentState.initialPrompt) promptInput.value = agentState.initialPrompt || '';
      }

      const selectedProvider = PROVIDER_ORDER[activeAgentProviderIndex()];
      const providerHost = document.getElementById('agent-provider-select');
      if (providerHost) providerHost.innerHTML = providerSelectionCard(selectedProvider, 'agent-provider-select-card');

      bindAgentModalInteractions();
      bindProviderSwipeCard('agent-provider-select-card', rotateAgentProvider);
    }

    async function loadDirectory(targetPath) {
      pickerState.loading = true;
      renderDirectoryPicker();
      const payload = await apiGet('/api/directories?path=' + encodeURIComponent(targetPath || HOME_DIRECTORY));
      pickerState.path = payload.path || HOME_DIRECTORY;
      pickerState.parent = payload.parent || null;
      pickerState.directories = Array.isArray(payload.directories) ? payload.directories : [];
      pickerState.loading = false;
      renderDirectoryPicker();
    }

    function renderDirectoryPicker() {
      const pathEl = document.getElementById('dir-picker-path');
      if (pathEl) pathEl.textContent = pickerState.path || HOME_DIRECTORY;
      const listEl = document.getElementById('dir-picker-list');
      if (listEl) {
        if (pickerState.loading) {
          listEl.innerHTML = '<div class="line muted">Loading folders…</div>';
        } else if (!pickerState.directories.length) {
          listEl.innerHTML = '<div class="line muted">No subfolders here.</div>';
        } else {
          listEl.innerHTML = pickerState.directories
            .map((entry) => '<button type="button" class="picker-item" data-dir-path="' + esc(entry.path) + '">' + esc(entry.name) + '</button>')
            .join('');
        }
      }

      const upBtn = document.getElementById('dir-picker-up');
      if (upBtn) upBtn.disabled = !pickerState.parent;
      bindDirectoryPickerInteractions();
    }

    function bindProviderSwipeCard(cardOrId, rotateFn) {
      const card = typeof cardOrId === 'string' ? document.getElementById(cardOrId) : cardOrId;
      if (!card || card.dataset.swipeBound === '1') return;
      card.dataset.swipeBound = '1';
      card.style.touchAction = 'pan-y';
      let swipeBlocked = false;
      let startX = null;
      let startY = null;
      card.addEventListener('touchstart', function (ev) {
        if (!ev.touches || !ev.touches[0]) return;
        const t = ev.target;
        swipeBlocked = !!(t && t.closest && t.closest('[data-toggle-provider],button,a,input,textarea,select,label'));
        startX = ev.touches[0].clientX;
        startY = ev.touches[0].clientY;
      }, { passive: true });
      card.addEventListener('touchend', function (ev) {
        if (startX === null || startY === null) return;
        if (!ev.changedTouches || !ev.changedTouches[0]) {
          startX = null;
          startY = null;
          return;
        }
        const deltaX = ev.changedTouches[0].clientX - startX;
        const deltaY = ev.changedTouches[0].clientY - startY;
        startX = null;
        startY = null;
        if (swipeBlocked) {
          swipeBlocked = false;
          return;
        }
        if (Math.abs(deltaX) < 35) return;
        if (Math.abs(deltaX) <= Math.abs(deltaY)) return;
        rotateFn(deltaX < 0 ? 1 : -1);
      });
    }

    function bindPersonaSwipe() {
      const card = document.getElementById('persona-select-card');
      if (!card || card.dataset.swipeBound === '1') return;
      card.dataset.swipeBound = '1';
      let startX = null;
      card.addEventListener('touchstart', function (ev) {
        if (!ev.touches || !ev.touches[0]) return;
        startX = ev.touches[0].clientX;
      }, { passive: true });
      card.addEventListener('touchend', function (ev) {
        if (startX === null) return;
        if (!ev.changedTouches || !ev.changedTouches[0]) {
          startX = null;
          return;
        }
        const delta = ev.changedTouches[0].clientX - startX;
        startX = null;
        if (Math.abs(delta) < 35) return;
        rotatePersona(delta < 0 ? 1 : -1);
      });
    }

    function bindHotDialInteractions() {
      const cards = document.querySelectorAll('[data-agent-dial-id]');
      for (const card of cards) {
        if (card.dataset.bound === '1') continue;
        card.dataset.bound = '1';
        card.addEventListener('click', function (ev) {
          ev.preventDefault();
          const dialId = card.getAttribute('data-agent-dial-id');
          if (!dialId) return;
          if (dialId === 'calendar_manager') {
            location.assign('/calendar');
          } else {
            openAgentModal(dialId);
          }
        });
      }
    }

    function bindAgentModalInteractions() {
      const prev = document.getElementById('agent-provider-prev');
      if (prev && prev.dataset.bound !== '1') {
        prev.dataset.bound = '1';
        prev.addEventListener('click', function (ev) {
          ev.preventDefault();
          rotateAgentProvider(-1);
        });
      }
      const next = document.getElementById('agent-provider-next');
      if (next && next.dataset.bound !== '1') {
        next.dataset.bound = '1';
        next.addEventListener('click', function (ev) {
          ev.preventDefault();
          rotateAgentProvider(1);
        });
      }
      const promptInput = document.getElementById('agent-initial-prompt');
      if (promptInput && promptInput.dataset.bound !== '1') {
        promptInput.dataset.bound = '1';
        promptInput.addEventListener('input', function () {
          agentState.initialPrompt = String(promptInput.value || '');
        });
      }
    }

    function bindIntentModalInteractions() {
      const prev = document.getElementById('provider-prev');
      if (prev && prev.dataset.bound !== '1') {
        prev.dataset.bound = '1';
        prev.addEventListener('click', function (ev) {
          ev.preventDefault();
          rotateProvider(-1);
        });
      }
      const next = document.getElementById('provider-next');
      if (next && next.dataset.bound !== '1') {
        next.dataset.bound = '1';
        next.addEventListener('click', function (ev) {
          ev.preventDefault();
          rotateProvider(1);
        });
      }

      const personaPrev = document.getElementById('persona-prev');
      if (personaPrev && personaPrev.dataset.bound !== '1') {
        personaPrev.dataset.bound = '1';
        personaPrev.addEventListener('click', function (ev) {
          ev.preventDefault();
          rotatePersona(-1);
        });
      }
      const personaNext = document.getElementById('persona-next');
      if (personaNext && personaNext.dataset.bound !== '1') {
        personaNext.dataset.bound = '1';
        personaNext.addEventListener('click', function (ev) {
          ev.preventDefault();
          rotatePersona(1);
        });
      }

      const templateButtons = document.querySelectorAll('[data-template]');
      for (const btn of templateButtons) {
        if (btn.dataset.bound === '1') continue;
        btn.dataset.bound = '1';
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          intentState.templateId = btn.getAttribute('data-template') || 'new_brainstorm';
          if (intentState.templateId === 'new_brainstorm') intentState.workdir = HOME_DIRECTORY;
          renderIntentModal();
        });
      }

      const chooseWorkdir = document.getElementById('choose-workdir');
      if (chooseWorkdir && chooseWorkdir.dataset.bound !== '1') {
        chooseWorkdir.dataset.bound = '1';
        chooseWorkdir.addEventListener('click', function (ev) {
          ev.preventDefault();
          openDirPicker();
        });
      }

      const recentList = document.getElementById('recent-workdirs-list');
      if (recentList && recentList.dataset.bound !== '1') {
        recentList.dataset.bound = '1';
        recentList.addEventListener('click', function (ev) {
          const btn = ev.target.closest('[data-recent-workdir]');
          if (!btn) return;
          ev.preventDefault();
          const nextWorkdir = btn.getAttribute('data-recent-workdir');
          if (!nextWorkdir) return;
          intentState.workdir = nextWorkdir;
          renderIntentModal();
        });
      }

      const personaHost = document.getElementById('persona-selector');
      if (personaHost && personaHost.dataset.bound !== '1') {
        personaHost.dataset.bound = '1';
        personaHost.addEventListener('click', function (ev) {
          const btn = ev.target.closest('[data-persona-id]');
          if (!btn) return;
          ev.preventDefault();
          intentState.personaId = normalizePersonaForTemplate(btn.getAttribute('data-persona-id'), intentState.templateId);
          renderIntentModal();
        });
      }

      bindPersonaSwipe();
    }

    function bindDirectoryPickerInteractions() {
      const listEl = document.getElementById('dir-picker-list');
      if (listEl && listEl.dataset.bound !== '1') {
        listEl.dataset.bound = '1';
        listEl.addEventListener('click', function (ev) {
          const btn = ev.target.closest('[data-dir-path]');
          if (!btn) return;
          const nextPath = btn.getAttribute('data-dir-path');
          if (!nextPath) return;
          loadDirectory(nextPath).catch((err) => {
            alert('Failed to open folder: ' + err.message);
          });
        });
      }
    }

    function bindStaticModalInteractions() {
      const intentClose = document.getElementById('intent-close');
      if (intentClose) intentClose.addEventListener('click', function (ev) { ev.preventDefault(); closeIntentModal(); });
      const intentCancel = document.getElementById('intent-cancel');
      if (intentCancel) intentCancel.addEventListener('click', function (ev) { ev.preventDefault(); closeIntentModal(); });
      const intentOverlay = document.getElementById('intent-modal');
      if (intentOverlay) {
        intentOverlay.addEventListener('click', function (ev) {
          if (ev.target === intentOverlay) closeIntentModal();
        });
      }

      const intentConfirm = document.getElementById('intent-confirm');
      if (intentConfirm) {
        intentConfirm.addEventListener('click', async function (ev) {
          ev.preventDefault();
          if (!intentState.name) return;
          const targetName = intentState.name;
          const payload = {
            provider: intentState.providerKey,
            templateId: intentState.templateId,
            personaId: intentState.personaId,
            workdir: intentState.templateId === 'continue_work' ? intentState.workdir : HOME_DIRECTORY,
          };
          closeIntentModal();
          // The user clicked the card directly, so it's already visible — no autoScroll needed.
          await spawnSession(targetName, payload, { autoScroll: false });
        });
      }

      const agentClose = document.getElementById('agent-close');
      if (agentClose) agentClose.addEventListener('click', function (ev) { ev.preventDefault(); closeAgentModal(); });
      const agentCancel = document.getElementById('agent-cancel');
      if (agentCancel) agentCancel.addEventListener('click', function (ev) { ev.preventDefault(); closeAgentModal(); });
      const agentOverlay = document.getElementById('agent-modal');
      if (agentOverlay) {
        agentOverlay.addEventListener('click', function (ev) {
          if (ev.target === agentOverlay) closeAgentModal();
        });
      }
      const agentConfirm = document.getElementById('agent-confirm');
      if (agentConfirm) {
        agentConfirm.addEventListener('click', async function (ev) {
          ev.preventDefault();
          if (!agentState.dialId) return;
          const payload = { dialId: agentState.dialId, provider: agentState.providerKey };
          const initialPrompt = String(agentState.initialPrompt || '').trim();
          if (initialPrompt) payload.initialPrompt = initialPrompt;
          closeAgentModal();
          await launchHotDialAgent(payload, { autoScroll: true });
        });
      }

      const pickerClose = document.getElementById('dir-picker-close');
      if (pickerClose) pickerClose.addEventListener('click', function (ev) { ev.preventDefault(); closeDirPicker(); });
      const pickerOverlay = document.getElementById('dir-picker-modal');
      if (pickerOverlay) {
        pickerOverlay.addEventListener('click', function (ev) {
          if (ev.target === pickerOverlay) closeDirPicker();
        });
      }

      const pickerUp = document.getElementById('dir-picker-up');
      if (pickerUp) {
        pickerUp.addEventListener('click', function (ev) {
          ev.preventDefault();
          if (!pickerState.parent) return;
          loadDirectory(pickerState.parent).catch((err) => {
            alert('Failed to go up: ' + err.message);
          });
        });
      }

      const pickerSelect = document.getElementById('dir-picker-select');
      if (pickerSelect) {
        pickerSelect.addEventListener('click', function (ev) {
          ev.preventDefault();
          intentState.workdir = pickerState.path || HOME_DIRECTORY;
          closeDirPicker();
          renderIntentModal();
        });
      }

      const profileSwitchClose = document.getElementById('profile-switch-close');
      if (profileSwitchClose) profileSwitchClose.addEventListener('click', function (ev) { ev.preventDefault(); closeProfileSwitchModal(); });
      const profileSwitchCancel = document.getElementById('profile-switch-cancel');
      if (profileSwitchCancel) profileSwitchCancel.addEventListener('click', function (ev) { ev.preventDefault(); closeProfileSwitchModal(); });
      const profileSwitchOverlay = document.getElementById('profile-switch-modal');
      if (profileSwitchOverlay) {
        profileSwitchOverlay.addEventListener('click', function (ev) {
          if (ev.target === profileSwitchOverlay) closeProfileSwitchModal();
        });
      }

      const killClose = document.getElementById('kill-close');
      if (killClose) killClose.addEventListener('click', function (ev) { ev.preventDefault(); closeKillModal(); });
      const killNo = document.getElementById('kill-no');
      if (killNo) killNo.addEventListener('click', function (ev) { ev.preventDefault(); closeKillModal(); });
      const killOverlay = document.getElementById('kill-modal');
      if (killOverlay) {
        killOverlay.addEventListener('click', function (ev) {
          if (ev.target === killOverlay) closeKillModal();
        });
      }
      const killYes = document.getElementById('kill-yes');
      if (killYes) {
        killYes.addEventListener('click', async function (ev) {
          ev.preventDefault();
          if (!killState.name) return;
          const target = killState.name;
          closeKillModal();
          await killSession(target, { autoScroll: true });
        });
      }
    }

    async function prewarmPublicEndpoint(port) {
      const base = hostForPort(port);
      const ctl = new AbortController();
      const t = setTimeout(function () {
        ctl.abort();
      }, 1200);
      try {
        await fetch(base + '/?atc_prewarm=' + Date.now(), {
          method: 'GET',
          cache: 'no-store',
          signal: ctl.signal,
          credentials: 'omit',
        });
      } catch (_e) {
        // best-effort only
      } finally {
        clearTimeout(t);
      }
    }

    async function spawnSession(name, options, uiOptions = {}) {
      if (refreshing.has(name)) return;
      refreshing.add(name);
      spawning.add(name);
      refresh().catch(() => {});
      try {
        const payload = { name: name, ...(options || {}) };
        payload.personaId = normalizePersonaId(payload.personaId);
        await apiPost('/api/sessions/spawn', payload);
      } catch (err) {
        alert('Spawn failed for ' + name + ': ' + err.message);
      } finally {
        spawning.delete(name);
        refreshing.delete(name);
        await refresh();
        if (uiOptions && uiOptions.autoScroll) focusSessionCard(name);
        setTimeout(refresh, 350);
        setTimeout(refresh, 900);
        setTimeout(refresh, 1600);
        setTimeout(refresh, 2400);
      }
    }

    async function launchHotDialAgent(options, uiOptions = {}) {
      let slotName = '';
      try {
        const result = await apiPost('/api/agents/spawn', options || {});
        slotName = String(result && result.slotName ? result.slotName : '').trim();
        if (slotName) {
          spawning.add(slotName);
          if (uiOptions && uiOptions.autoScroll) focusSessionCard(slotName);
        }
      } catch (err) {
        alert('Agent launch failed: ' + err.message);
      } finally {
        if (slotName) spawning.delete(slotName);
        await refresh();
        if (slotName && uiOptions && uiOptions.autoScroll) {
          focusSessionCard(slotName);
        }
      }
    }

    async function killSession(name, uiOptions = {}) {
      if (refreshing.has(name)) return;
      refreshing.add(name);
      killing.add(name);
      if (uiOptions && uiOptions.autoScroll) focusSessionCard(name);
      refresh().catch(() => {});
      try {
        await apiPost('/api/sessions/kill', { name: name });
      } catch (err) {
        alert('Kill failed for ' + name + ': ' + err.message);
      } finally {
        killing.delete(name);
        refreshing.delete(name);
        await refresh();
        if (uiOptions && uiOptions.autoScroll) {
          focusSessionCard(name);
        }
      }
    }

    function sessionCard(s) {
      const hasBackend = s.status === 'active' && s.backendActive;
      const isSpawning = spawning.has(s.name);
      const isKilling = killing.has(s.name);
      const FIVE_MIN = 5 * 60 * 1000;
      const isActive = hasBackend && s.lastInteractionMs != null && s.lastInteractionMs < FIVE_MIN;
      const isIdle = hasBackend && !isActive;
      const isUnborn = !hasBackend && !isSpawning;
      const sessionState = isSpawning ? 'starting' : (isActive ? 'active' : (isIdle ? 'idle' : 'unborn'));
      const hasAgent = !!(s.telemetry && s.telemetry.agentType && s.telemetry.agentType !== 'none');
      const personaId = normalizePersonaId(s.personaId);
      const pictureSrc = sessionPictureSrc(s);
      const pictureAlt = s.name + ' portrait';
      const rawTaskTitle = String(s.taskTitle || '').trim();
      const taskTitle = rawTaskTitle && !/^shell:\s*/i.test(rawTaskTitle) ? rawTaskTitle : 'Not set';
      const actionText = isKilling ? 'Stopping terminal…' : (isSpawning ? 'Starting terminal…' : (hasBackend ? 'Tap to connect' : 'Tap to start'));
      const actionClass = isKilling ? 'color-killing' : (isSpawning ? 'color-starting' : (isActive ? 'color-active' : (isIdle ? 'color-idle' : 'color-unborn')));
      const badgeClass = sessionState;
      const badgeText = sessionState;
      const hat = personaHatMarkup(personaForId(personaId), 'session');

      const providerKey = s.provider || 'codex';
      const providerLogoMap = { codex: '/assets/logos/openai.svg?v=2', claude: '/assets/logos/anthropic.svg?v=2', gemini: '/assets/logos/google.svg?v=2' };
      const providerLogoSrc = providerLogoMap[providerKey] || providerLogoMap.codex;
      const agentIconKind = (s.agentType === 'calendar_manager') ? 'calendar' : (s.agentType === 'second_brain') ? 'brain' : null;
      const agentTypeTag = agentIconKind && !isUnborn ? '<span class="agent-type-tag">' + dialIconSvg(agentIconKind, 'agent-type-icon') + '</span>' : '';
      const renderKey = [
        sessionState,
        hasBackend ? '1' : '0',
        isSpawning ? '1' : '0',
        isKilling ? '1' : '0',
        personaId,
        pictureSrc,
        taskTitle,
        s.workdir || '',
        providerKey,
        hasAgent ? '1' : '0',
        String(s.agentType || ''),
        String((s.telemetry && s.telemetry.turnCount) ? s.telemetry.turnCount : 0),
        String((s.telemetry && Number.isFinite(Number(s.telemetry.contextWindowPct))) ? Math.round(Number(s.telemetry.contextWindowPct)) : 'na'),
        s.startedAgo || 'n/a',
        s.lastInteractionAgo || 'n/a',
        s.error || '',
      ].join('::');

      return '<article class="session tap state-' + esc(sessionState) + (isSpawning ? ' spawning' : '') + (isKilling ? ' killing' : '') + '" data-name="' + esc(s.name) + '" data-picture-src="' + esc(pictureSrc) + '" data-persona-id="' + esc(personaId) + '" data-active="' + (hasBackend ? '1' : '0') + '" data-spawning="' + (isSpawning ? '1' : '0') + '" data-killing="' + (isKilling ? '1' : '0') + '" data-render-key="' + esc(renderKey) + '">' +
        agentTypeTag +
        (!isUnborn ? '<span class="provider-tag"><img src="' + esc(providerLogoSrc) + '" alt="' + esc(providerKey) + '" width="20" height="20" /></span>' : '') +
        '<button type="button" class="kill" ' + (hasBackend ? '' : 'disabled') + ' data-kill="1" data-name="' + esc(s.name) + '" aria-label="Kill ' + esc(s.name) + '">&times;</button>' +
        '<div class="session-media">' +
          (pictureSrc
            ? '<img class="session-picture" src="' + esc(pictureSrc) + '" alt="' + esc(pictureAlt) + '" loading="lazy" decoding="async" />'
            : '<div class="session-media-fallback" aria-hidden="true">' + esc(String(s.name || '?').trim().slice(0, 1).toUpperCase()) + '</div>') +
        '</div>' +
        hat +
        '<div class="session-body">' +
          '<div class="head">' +
            '<div class="head-main">' +
              '<div class="name">' + esc(s.name) + '</div>' +
              '<div class="head-badges">' +
                '<span class="badge ' + esc(badgeClass) + '">' + esc(badgeText) + '</span>' +
                personaBadge(personaId) +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="line"><strong>Task:</strong> ' + esc(taskTitle) + '</div>' +
          '<div class="line"><strong>Workdir:</strong> ' + esc(s.workdir || 'Not set') + '</div>' +
          (hasAgent
            ? '<div class="line muted">Agent: ' + esc(s.agentType || 'none') + ' | Turns: ' + esc((s.telemetry && s.telemetry.turnCount) ? s.telemetry.turnCount : 0) + '</div>'
            : '') +
          (hasAgent
            ? '<div class="line muted">Context window: ' + esc((s.telemetry && Number.isFinite(Number(s.telemetry.contextWindowPct))) ? (Math.round(Number(s.telemetry.contextWindowPct)) + '%') : 'N/A') + '</div>'
            : '') +
          '<div class="line muted">Active for: ' + esc(s.startedAgo || 'n/a') + ' | Last interaction: ' + (isIdle ? '<strong>' : '') + esc(s.lastInteractionAgo || 'n/a') + (isIdle ? '</strong>' : '') + '</div>' +
          (s.error ? '<div class="line error">' + esc(s.error) + '</div>' : '') +
          '<div class="action-hint ' + actionClass + '">' + esc(actionText) + '</div>' +
        '</div>' +
      '</article>';
    }

    function makeSessionCardNode(htmlString) {
      const template = document.createElement('template');
      template.innerHTML = htmlString.trim();
      return template.content.firstElementChild;
    }

    function bindSessionInteractions() {
      if (sessionInteractionsBound) return;
      const sessionsEl = document.getElementById('sessions');
      if (!sessionsEl) return;
      sessionInteractionsBound = true;

      sessionsEl.addEventListener('click', async function (ev) {
        const killBtn = ev.target.closest('[data-kill="1"]');
        if (killBtn) {
          ev.stopPropagation();
          if (killBtn.hasAttribute('disabled')) return;
          const killName = killBtn.getAttribute('data-name');
          if (!killName) return;
          openKillModal(killName);
          return;
        }

        const card = ev.target.closest('.session.tap');
        if (!card || !sessionsEl.contains(card)) return;
        const name = card.getAttribute('data-name');
        const item = latestSessionsByName.get(name);
        if (!item) return;

        const active = item.status === 'active' && item.backendActive;
        const isSpawning = spawning.has(item.name);
        if (isSpawning) return;
        if (active) {
          await prewarmPublicEndpoint(item.publicPort);
          window.open(connectUrlForPort(item.publicPort), '_blank', 'noopener,noreferrer');
          return;
        }
        openIntentModal(item.name, card.getAttribute('data-picture-src') || '');
      });
    }

    function renderUsageGrid(usage) {
      const nextUsage = usage && typeof usage === 'object' ? { ...usage } : {};
      if (claudeSwitchingAlias) {
        for (const provider of ['codex', 'gemini']) {
          if (nextUsage[provider]?.loading && latestUsage?.[provider]) nextUsage[provider] = latestUsage[provider];
        }
      }
      latestUsage = nextUsage;
      const usageGrid = document.getElementById('usage-grid');
      const activeProfile = nextUsage?.activeProfile || null;
      const rows = [
        providerUsageRow('codex', 'Codex', nextUsage.codex, activeProfile, []),
        providerUsageRow('claude', 'Claude', nextUsage.claude, activeProfile, latestProfiles),
        providerUsageRow('gemini', 'Gemini', nextUsage.gemini, activeProfile, []),
      ];
      const nextUsageHtml = rows.join('');
      if (usageGrid && usageGrid.innerHTML !== nextUsageHtml) {
        usageGrid.innerHTML = nextUsageHtml;
        bindUsageInteractions();
      }
      bindUsageRefreshTicker();
      if (profileSwitchState.open) renderProfileSwitchModal();
    }

    function renderSessions(sessionsPayload) {
      const sessions = sessionsPayload.sessions || [];
      latestSessionsByName = new Map(sessions.map(function (s) { return [s.name, s]; }));
      const latestRecent = Array.isArray(sessionsPayload.recentWorkdirs) ? sessionsPayload.recentWorkdirs : [];
      recentWorkdirs.splice(0, recentWorkdirs.length, ...latestRecent);
      const sessionsEl = document.getElementById('sessions');
      if (!sessionsEl) return;

      if (sessions.length === 0) {
        const emptyHtml = '<div class="line muted">No sessions configured.</div>';
        if (sessionsEl.innerHTML !== emptyHtml) sessionsEl.innerHTML = emptyHtml;
        return;
      }

      const existingCards = new Map();
      const existingElements = Array.from(sessionsEl.children).filter(function (el) {
        return el.matches && el.matches('.session.tap[data-name]');
      });
      for (const el of existingElements) {
        existingCards.set(el.getAttribute('data-name'), el);
      }

      sessions.forEach(function (s, index) {
        const nextNode = makeSessionCardNode(sessionCard(s));
        const nextKey = nextNode ? nextNode.getAttribute('data-render-key') : '';
        const existing = existingCards.get(s.name);
        let cardEl = existing;
        if (!cardEl) {
          cardEl = nextNode;
        } else if ((cardEl.getAttribute('data-render-key') || '') !== (nextKey || '')) {
          cardEl.replaceWith(nextNode);
          cardEl = nextNode;
        }

        const anchoredAt = sessionsEl.children[index] || null;
        if (cardEl !== anchoredAt) sessionsEl.insertBefore(cardEl, anchoredAt);
      });

      const validNames = new Set(sessions.map(function (s) { return s.name; }));
      for (const el of Array.from(sessionsEl.children)) {
        if (!el.matches || !el.matches('.session.tap[data-name]')) {
          el.remove();
          continue;
        }
        if (!validNames.has(el.getAttribute('data-name'))) el.remove();
      }
    }

    async function refresh(options = {}) {
      const includeUsage = Object.prototype.hasOwnProperty.call(options, 'usage') ? !!options.usage : true;
      const sessionsTask = fetch('/api/sessions', { cache: 'no-store' })
        .then(function (resp) { return resp.json(); })
        .then(function (payload) { renderSessions(payload || {}); })
        .catch(function () {});

      const usageTask = includeUsage
        ? fetch('/api/usage', { cache: 'no-store' })
            .then(function (resp) { return resp.json(); })
            .then(function (usage) { renderUsageGrid(usage || {}); })
            .catch(function () {
              renderUsageGrid(latestUsage);
            })
        : Promise.resolve();

      const profilesTask = fetch('/api/profiles', { cache: 'no-store' })
        .then(function (resp) { return resp.json(); })
        .then(function (payload) {
          if (payload && Array.isArray(payload.profiles)) {
            latestProfiles = payload.profiles;
            if (payload.active) latestUsage = { ...(latestUsage || {}), activeProfile: payload.active };
            if (profileSwitchState.open) renderProfileSwitchModal();
            renderUsageGrid(latestUsage);
          }
        })
        .catch(function () {});

      await Promise.allSettled([sessionsTask, usageTask, profilesTask]);
    }

    bindStaticModalInteractions();
    bindSessionInteractions();
    renderHotDials();
    refresh();
    setInterval(function () { refresh({ usage: false }); }, ${REFRESH_MS});
  </script>
</body>
</html>`;
}

function renderCalendarPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calendar</title>
  <style>
    html { background: #1b1d1e; }
    :root {
      --bg0: #1b1d1e;
      --bg1: #232526;
      --text: #f8f8f2;
      --muted: #7e8e91;
      --line: #49483e;
      --green: #a6e22e;
      --amber: #e6db74;
      --red: #f92672;
      --cyan: #66d9ef;
      --purple: #ae81ff;
      --surface0: #232526;
      --surface1: #293739;
      --accent: #fd971f;
      --accent-strong: #f92672;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(1200px 600px at 0% -20%, #d7992124 0%, transparent 55%),
        radial-gradient(1000px 600px at 100% 0%, #689d6a1f 0%, transparent 50%),
        linear-gradient(180deg, var(--bg0) 0%, var(--bg1) 100%);
      min-height: 100vh;
      padding: 16px;
    }
    .calendar-page {
      max-width: 700px;
      margin: 0 auto;
      transition: max-width 200ms ease-out;
    }
    .calendar-page.week-view-active {
      max-width: 980px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding: 14px 16px;
      border: 1px solid #665c54;
      border-radius: 12px;
      background:
        radial-gradient(280px 90px at 94% 18%, #d7992130 0%, transparent 78%),
        linear-gradient(180deg, #3a342f, #2a2624);
      box-shadow: 0 10px 28px #00000033;
      position: relative;
      overflow: hidden;
    }
    header::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #d79921 0%, #fe8019 60%, #fb4934 100%);
      opacity: 0.95;
    }
    header::after {
      content: "";
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(-45deg, transparent 0 14px, #1d202110 14px 15px);
      pointer-events: none;
    }
    header h1 {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: 0.05em;
      position: relative;
      z-index: 1;
    }
    .back-btn {
      position: relative;
      z-index: 1;
      padding: 8px 12px;
      background: #3c3836;
      border: 1px solid #7c6f64;
      border-radius: 7px;
      color: #ebdbb2;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    .back-btn:hover { background: #504945; border-color: #928374; }
    .header-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      position: relative;
      z-index: 1;
    }
    .refresh-ring-btn {
      position: relative;
      width: 34px;
      height: 34px;
      border-radius: 999px;
      border: none;
      padding: 0;
      cursor: pointer;
      color: #ebdbb2;
      background: conic-gradient(#d79921 calc(var(--refresh-pct, 0) * 1%), #3a3634 0);
      display: grid;
      place-items: center;
      box-sizing: border-box;
    }
    .refresh-ring-btn::after {
      content: "";
      position: absolute;
      inset: 4px;
      border-radius: 999px;
      background: #3c3836;
      border: none;
      box-sizing: border-box;
      transition: background 100ms ease-out;
    }
    .refresh-ring-btn:hover::after { background: #504945; }
    .refresh-ring-btn .refresh-icon {
      position: relative;
      z-index: 1;
      width: 18px;
      height: 18px;
    }
    .refresh-ring-btn.refreshing {
      pointer-events: none;
      background: conic-gradient(#d79921 0%, #d79921 25%, #3a3634 25%);
      animation: refresh-dial-rotate 1s linear infinite;
    }
    .refresh-ring-btn.refreshing::after {
      transition: none;
    }
    .refresh-ring-btn.refreshing .refresh-icon {
      animation: refresh-icon-counter 1s linear infinite;
    }
    @keyframes refresh-dial-rotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    @keyframes refresh-icon-counter {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(-360deg); }
    }
    .refresh-ring-btn:active:not(.refreshing)::after {
      background: #504945;
    }
    .brief-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      gap: 16px;
    }
    .brief-date {
      font-size: 12px;
      color: #d5c4a1;
      font-weight: 600;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      background: #2a2624;
      padding: 3px;
      border-radius: 8px;
      border: 1px solid #665c54;
      width: fit-content;
    }
    .tab {
      padding: 6px 14px;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: #a89984;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      font-family: inherit;
    }
    .tab.active {
      background: linear-gradient(180deg, #d79921, #d97706);
      color: #1b1d1e;
    }
    .day-header {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: #fd971f;
      margin: 12px 0 6px;
      padding-left: 2px;
    }
    .day-header:first-child { margin-top: 0; }
    /* Week view: Google Calendar-style multi-day timeline */
    .week-timeline {
      display: grid;
      grid-template-columns: 40px repeat(7, 1fr);
      grid-template-rows: auto 1fr;
      gap: 2px;
      position: relative;
    }
    .week-hours-header {
      border-bottom: 1px solid #665c54;
    }
    .week-day-header {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: #fd971f;
      text-align: center;
      line-height: 1.25;
      padding: 4px 2px;
      border-bottom: 1px solid #665c54;
      white-space: nowrap;
    }
    .week-day-header.today {
      background: rgba(215, 153, 33, 0.12);
      color: #ffd866;
      border-radius: 4px 4px 0 0;
    }
    .week-day-header .wd-num {
      display: block;
      font-size: 12px;
      font-weight: 800;
      margin-top: 1px;
    }
    .week-day-col {
      position: relative;
      border-left: 1px solid #49483e;
      background-image:
        repeating-linear-gradient(
          to bottom,
          #3a3634 0,
          #3a3634 1px,
          transparent 1px,
          transparent 60px
        ),
        repeating-linear-gradient(
          to bottom,
          transparent 0,
          transparent 29px,
          #2f2b2a 29px,
          #2f2b2a 30px,
          transparent 30px,
          transparent 60px
        );
    }
    .week-day-col.today {
      background-color: rgba(215, 153, 33, 0.04);
    }
    /* Compact events for the narrow week columns */
    .tl-event.compact {
      padding: 2px 4px;
      font-size: 10px;
      line-height: 1.15;
    }
    .tl-event.compact .tl-event-title {
      font-size: 10px;
      white-space: normal;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .tl-event-time-stack {
      font-size: 9px;
      opacity: 0.9;
      line-height: 1.1;
      margin-top: 1px;
    }
    .tl-event-time-stack div {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tl-event.compact.short {
      padding: 1px 4px;
      display: block;
    }
    .tl-event.compact.short .tl-event-title {
      -webkit-line-clamp: 1;
      font-size: 9px;
    }
    .tl-event.compact.short .tl-event-time-stack {
      display: none;
    }
    /* Google Calendar-style timeline for today view */
    .timeline {
      display: grid;
      grid-template-columns: 44px 1fr;
      gap: 4px;
      position: relative;
    }
    .tl-hours {
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .tl-hour {
      font-size: 10px;
      color: #928374;
      text-align: right;
      padding-right: 6px;
      line-height: 1;
      padding-top: 2px;
      font-weight: 600;
      letter-spacing: 0.2px;
    }
    .tl-grid {
      position: relative;
      border-left: 1px solid #49483e;
      background-image:
        repeating-linear-gradient(
          to bottom,
          #3a3634 0,
          #3a3634 1px,
          transparent 1px,
          transparent 60px
        ),
        repeating-linear-gradient(
          to bottom,
          transparent 0,
          transparent 29px,
          #2f2b2a 29px,
          #2f2b2a 30px,
          transparent 30px,
          transparent 60px
        );
    }
    .tl-event {
      position: absolute;
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 11px;
      color: #fff;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(0,0,0,0.25);
      cursor: pointer;
      line-height: 1.2;
      border-left: 3px solid rgba(0,0,0,0.25);
    }
    .tl-event-title {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tl-event-time {
      font-size: 10px;
      opacity: 0.88;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tl-event.short {
      padding: 1px 6px;
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .tl-event.short .tl-event-title {
      flex: 1;
      min-width: 0;
    }
    .tl-event.short .tl-event-time {
      flex-shrink: 0;
    }
    .tl-event.past { opacity: 0.5; }
    .tl-event.routine { opacity: 0.7; }
    .tl-now-line {
      position: absolute;
      left: -6px;
      right: 0;
      height: 2px;
      background: #f92672;
      z-index: 20;
      pointer-events: none;
      box-shadow: 0 0 6px rgba(249, 38, 114, 0.55);
    }
    .tl-now-line::before {
      content: "";
      position: absolute;
      left: -4px;
      top: -4px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #f92672;
      box-shadow: 0 0 8px rgba(249, 38, 114, 0.7);
    }
    .tl-now-label {
      position: absolute;
      right: 4px;
      top: -18px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.4px;
      color: #f92672;
      background: #2a2624;
      padding: 2px 6px;
      border-radius: 8px;
      border: 1px solid #f92672;
      white-space: nowrap;
    }
    .section {
      background: linear-gradient(180deg, #3a342f 0%, #2a2624 100%);
      border: 1px solid #665c54;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
      box-shadow: 0 10px 28px #00000033;
    }
    .section-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      color: #d5c4a1;
      margin-bottom: 12px;
    }
    .quick-ask {
      display: flex;
      gap: 8px;
    }
    .quick-ask input {
      flex: 1;
      padding: 10px 12px;
      border: 1px solid #7c6f64;
      border-radius: 8px;
      background: #3c3836;
      color: var(--text);
      font-size: 13px;
      font-family: inherit;
    }
    .quick-ask input::placeholder { color: #7e8e91; }
    .quick-ask input:focus {
      outline: none;
      border-color: #d79921;
      background: #504945;
    }
    .quick-ask button {
      padding: 10px 16px;
      background: linear-gradient(180deg, #d79921, #d97706);
      color: #1b1d1e;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.1px;
    }
    .quick-ask button:hover { background: linear-gradient(180deg, #e8a82f, #e67e0a); }
    .skeleton {
      background: linear-gradient(90deg, #3c3836 25%, #504945 50%, #3c3836 75%);
      background-size: 200% 100%;
      animation: loading 1.5s infinite;
      height: 50px;
      border-radius: 8px;
      margin-bottom: 8px;
    }
    @keyframes loading {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .event-list, .backlog-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .slots-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .event-item {
      padding: 6px 10px;
      border-radius: 6px;
      border: none;
      min-height: 28px;
      display: flex;
      flex-direction: row;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      color: #fff;
      font-weight: 500;
    }
    .event-item > div:first-child {
      font-size: 13px;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .event-item .event-time {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.9);
      margin-top: 0;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .event-item.slot-block {
      background: rgba(166, 226, 46, 0.15);
      border: 1px dashed #a6e22e;
      color: #a6e22e;
    }
    .event-item.slot-block .event-time {
      color: rgba(166, 226, 46, 0.9);
    }
    .event-item.routine {
      opacity: 0.65;
    }
    .event-item.past {
      opacity: 0.55;
    }
    .event-time { font-size: 11px; margin-top: 4px; opacity: 0.85; }
    /* Google Calendar event colors (color_id 1-11) - full background */
    .gc-color-1  { background: #7986cb; color: #fff; } /* Lavender */
    .gc-color-2  { background: #33b679; color: #fff; } /* Sage */
    .gc-color-3  { background: #8e24aa; color: #fff; } /* Grape */
    .gc-color-4  { background: #e67c73; color: #fff; } /* Flamingo */
    .gc-color-5  { background: #f6bf26; color: #000; } /* Banana */
    .gc-color-6  { background: #f4511e; color: #fff; } /* Tangerine */
    .gc-color-7  { background: #039be5; color: #fff; } /* Peacock */
    .gc-color-8  { background: #616161; color: #fff; } /* Graphite */
    .gc-color-9  { background: #3f51b5; color: #fff; } /* Blueberry */
    .gc-color-10 { background: #0b8043; color: #fff; } /* Basil */
    .gc-color-11 { background: #d50000; color: #fff; } /* Tomato */
    .gc-color-default { background: #4285f4; color: #fff; } /* Calendar default blue */
    /* Now-line separator */
    .now-line {
      position: relative;
      height: 2px;
      background: linear-gradient(90deg, transparent 0%, #fd971f 15%, #f92672 50%, #fd971f 85%, transparent 100%);
      margin: 8px 0;
      border-radius: 2px;
    }
    .now-line::before {
      content: "NOW " attr(data-time);
      position: absolute;
      left: 50%;
      top: -9px;
      transform: translateX(-50%);
      background: #2a2624;
      border: 1px solid #665c54;
      border-radius: 10px;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: #fd971f;
    }
    .slot-item, .backlog-item {
      padding: 12px;
      background: #3c3836;
      border-radius: 8px;
      border-left: 3px solid var(--cyan);
      font-size: 13px;
      border: 1px solid #665c54;
      border-left-width: 3px;
    }
    .slot-item {
      border-left-color: var(--green);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .backlog-item {
      border-left-color: var(--accent);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .backlog-title {
      font-weight: 600;
    }
    .backlog-meta {
      font-size: 11px;
      color: #7e8e91;
      margin-top: 4px;
    }
    .backlog-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .action-btn {
      padding: 6px 10px;
      background: #504945;
      border: 1px solid #7c6f64;
      border-radius: 6px;
      color: #ebdbb2;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.1px;
    }
    .action-btn:hover { background: #665c54; border-color: #928374; }
    .backlog-add-btn {
      width: 100%;
      padding: 10px;
      background: transparent;
      border: 1px dashed #7c6f64;
      border-radius: 8px;
      color: #a89984;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      font-family: inherit;
      margin-bottom: 8px;
    }
    .backlog-add-btn:hover { border-color: #fd971f; color: #fd971f; }
    .backlog-form {
      display: none;
      flex-direction: column;
      gap: 8px;
      background: #2a2624;
      border: 1px solid #665c54;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 8px;
    }
    .backlog-form.open { display: flex; }
    .backlog-form input,
    .backlog-form select,
    .backlog-form textarea {
      padding: 8px 10px;
      border: 1px solid #7c6f64;
      border-radius: 6px;
      background: #3c3836;
      color: var(--text);
      font-size: 13px;
      font-family: inherit;
    }
    .backlog-form textarea { resize: vertical; min-height: 54px; }
    .backlog-form-row {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
    }
    .backlog-form-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .backlog-form-actions button {
      padding: 8px 14px;
      border-radius: 6px;
      border: 1px solid #7c6f64;
      background: #504945;
      color: #ebdbb2;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
    }
    .backlog-form-actions .primary {
      background: linear-gradient(180deg, #d79921, #d97706);
      color: #1b1d1e;
      border: none;
    }
    .priority-high { color: #f92672; font-weight: 700; }
    .priority-medium { color: #e6db74; }
    .priority-low { color: #7e8e91; }
    .backlog-badges {
      display: inline-flex;
      gap: 4px;
      margin-top: 4px;
      flex-wrap: wrap;
    }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #504945;
      color: #ebdbb2;
      font-weight: 600;
      letter-spacing: 0.3px;
      text-transform: uppercase;
    }
    .badge.stale { background: #f92672; color: #1b1d1e; }
    .badge.tag { background: #3c3836; color: #66d9ef; border: 1px solid #49483e; }
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 50;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: linear-gradient(180deg, #3a342f 0%, #2a2624 100%);
      border: 1px solid #665c54;
      border-radius: 12px;
      width: 100%;
      max-width: 520px;
      max-height: 80vh;
      overflow-y: auto;
      padding: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 14px;
    }
    .modal-title { font-size: 14px; font-weight: 800; letter-spacing: 0.3px; text-transform: uppercase; color: #fd971f; }
    .modal-subtitle { font-size: 12px; color: #a89984; margin-top: 4px; }
    .modal-close {
      background: transparent;
      border: none;
      color: #a89984;
      font-size: 20px;
      cursor: pointer;
      line-height: 1;
    }
    .slot-option {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      background: #3c3836;
      border: 1px solid #665c54;
      border-left: 3px solid #a6e22e;
      border-radius: 8px;
      margin-bottom: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    .slot-option:hover { background: #504945; }
    .slot-option.too-short {
      opacity: 0.4;
      cursor: not-allowed;
      border-left-color: #7e8e91;
    }
    .slot-day-header {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: #fd971f;
      margin: 12px 0 6px;
    }
    .slot-day-header:first-child { margin-top: 0; }
    .empty-state {
      text-align: center;
      padding: 24px;
      color: #7e8e91;
    }
    .last-updated {
      text-align: center;
      font-size: 11px;
      color: #7e8e91;
      margin-top: 16px;
      font-weight: 600;
      letter-spacing: 0.2px;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="calendar-page">
    <header>
      <h1>Calendar</h1>
      <div class="header-actions">
        <button class="refresh-ring-btn" id="refreshBtn" onclick="refreshDashboard()" aria-label="Refresh" style="--refresh-pct: 0;">
          <svg class="refresh-icon" viewBox="0 0 52 52" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M46.5,4h-3C42.7,4,42,4.7,42,5.5v7c0,0.9-0.5,1.3-1.2,0.7l0,0c-0.3-0.4-0.6-0.7-1-1c-5-5-12-7.1-19.2-5.7c-2.5,0.5-4.9,1.5-7,2.9c-6.1,4-9.6,10.5-9.7,17.5c-0.1,5.4,2,10.8,5.8,14.7c4,4.2,9.4,6.5,15.2,6.5c5.1,0,9.9-1.8,13.7-5c0.7-0.6,0.7-1.6,0.1-2.2l-2.1-2.1c-0.5-0.5-1.4-0.6-2-0.1c-3.6,3-8.5,4.2-13.4,3c-1.3-0.3-2.6-0.9-3.8-1.6C11.7,36.6,9,30,10.6,23.4c0.3-1.3,0.9-2.6,1.6-3.8C15,14.7,19.9,12,25.1,12c4,0,7.8,1.6,10.6,4.4c0.5,0.4,0.9,0.9,1.2,1.4c0.3,0.8-0.4,1.2-1.3,1.2h-7c-0.8,0-1.5,0.7-1.5,1.5v3.1c0,0.8,0.6,1.4,1.4,1.4h18.3c0.7,0,1.3-0.6,1.3-1.3V5.5C48,4.7,47.3,4,46.5,4z"/>
          </svg>
        </button>
        <button class="back-btn" onclick="history.back()">← Back</button>
      </div>
    </header>

    <div class="section">
      <div class="section-title">Quick Ask</div>
      <div class="quick-ask">
        <input type="text" id="quickAskInput" placeholder="What's on your mind?" />
        <button onclick="sendQuickAsk()">Ask</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Brief</div>
      <div class="brief-header">
        <div class="tabs">
          <button class="tab active" data-view="today" onclick="setBriefView('today')">Today</button>
          <button class="tab" data-view="week" onclick="setBriefView('week')">Week</button>
        </div>
        <div class="brief-date" id="briefDate"></div>
      </div>
      <div id="briefContent" class="loading">
        <div class="skeleton"></div>
        <div class="skeleton"></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Open Slots Today</div>
      <div id="slotsContent" class="loading">
        <div class="skeleton"></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Backlog</div>
      <button class="backlog-add-btn" onclick="toggleBacklogForm()">+ Add Item</button>
      <form class="backlog-form" id="backlogForm" onsubmit="submitBacklogForm(event)">
        <input type="text" id="bfTitle" placeholder="Title" required />
        <div class="backlog-form-row">
          <select id="bfPriority">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
          </select>
          <select id="bfEnergy">
            <option value="any" selected>Any energy</option>
            <option value="morning">Morning</option>
            <option value="afternoon">Afternoon</option>
            <option value="evening">Evening</option>
            <option value="weekend">Weekend</option>
          </select>
          <input type="number" id="bfEstimate" placeholder="mins" min="5" step="5" value="30" />
        </div>
        <input type="text" id="bfTags" placeholder="Tags (comma separated)" />
        <textarea id="bfNotes" placeholder="Notes (optional)"></textarea>
        <div class="backlog-form-actions">
          <button type="button" onclick="toggleBacklogForm()">Cancel</button>
          <button type="submit" class="primary">Add</button>
        </div>
      </form>
      <div id="backlogContent" class="loading">
        <div class="skeleton"></div>
      </div>
    </div>

    <div class="last-updated">
      Updated: <span id="lastUpdated">—</span>
    </div>
  </div>

  <div class="modal-backdrop" id="slotModal" onclick="if(event.target.id==='slotModal') closeSlotModal()">
    <div class="modal">
      <div class="modal-header">
        <div>
          <div class="modal-title">Slot It</div>
          <div class="modal-subtitle" id="slotModalSubtitle"></div>
        </div>
        <button class="modal-close" onclick="closeSlotModal()">✕</button>
      </div>
      <div id="slotModalBody"></div>
    </div>
  </div>

  <script>
    let briefView = 'today';
    let lastState = null;
    let calendarLastRefreshAt = 0;
    const CALENDAR_REFRESH_INTERVAL_MS = 60000; // 1 minute cooldown
    let calendarRefreshTicker = null;

    function tickCalendarRefreshCountdown() {
      const btn = document.getElementById('refreshBtn');
      if (!btn) return;

      // While actively refreshing, the .refreshing class owns the ring (spinner). Skip.
      if (btn.classList.contains('refreshing')) return;

      if (calendarLastRefreshAt === 0) {
        btn.style.setProperty('--refresh-pct', '0');
        return;
      }

      const now = Date.now();
      const elapsed = now - calendarLastRefreshAt;
      const remainingMs = Math.max(0, CALENDAR_REFRESH_INTERVAL_MS - elapsed);
      const pct = Math.max(0, Math.min(100, ((CALENDAR_REFRESH_INTERVAL_MS - remainingMs) / CALENDAR_REFRESH_INTERVAL_MS) * 100));
      btn.style.setProperty('--refresh-pct', String(pct));

      // Auto-trigger refresh when cooldown expires (button remains clickable throughout)
      if (remainingMs <= 0) {
        calendarLastRefreshAt = now; // prevent re-trigger while fetch is in flight
        loadDashboard(true);
      }
    }

    function bindCalendarRefreshTicker() {
      if (calendarRefreshTicker) clearInterval(calendarRefreshTicker);
      tickCalendarRefreshCountdown();
      calendarRefreshTicker = setInterval(tickCalendarRefreshCountdown, 1000);
    }

    function updateBriefDate() {
      const today = new Date();
      const dateStr = today.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      document.getElementById('briefDate').textContent = dateStr;
    }

    function setBriefView(view) {
      briefView = view;
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === view);
      });
      const page = document.querySelector('.calendar-page');
      if (page) page.classList.toggle('week-view-active', view === 'week');
      if (lastState) renderBrief(lastState);
    }

    const CACHE_KEY = 'calendarDashboardState';

    function loadFromCache() {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch { return null; }
    }
    function saveToCache(data) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
    }

    function formatDuration(minutes) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      if (h === 0) return m + 'm';
      if (m === 0) return h + 'h';
      return h + 'h ' + m + 'm';
    }

    function renderEventItem(ev) {
      const now = new Date();
      const startDate = new Date(ev.start);
      const endDate = new Date(ev.end);
      const isPast = endDate < now;
      const durationMs = endDate - startDate;
      const durationMins = Math.round(durationMs / 60000);
      const minHeight = 28 + Math.max(0, durationMins * 0.08);
      const routineClass = ev.routine ? ' routine' : '';
      const pastClass = isPast ? ' past' : '';
      const colorClass = ev.color_id ? ' gc-color-' + ev.color_id : ' gc-color-default';
      const start = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const end = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return \`<div class="event-item\${routineClass}\${pastClass}\${colorClass}" style="min-height: \${minHeight}px;">
        <div>\${ev.summary || '(untitled)'}</div>
        <span class="event-time">\${start} – \${end}</span>
      </div>\`;
    }

    function renderTodayTimeline(data, container) {
      const brief = data.brief || {};
      const rawEvents = (brief.all_events || brief.events || []).slice();
      const todayIso = brief.date || new Date().toISOString().slice(0, 10);
      if (rawEvents.length === 0) {
        container.innerHTML = '<div class="empty-state">No events today</div>';
        return;
      }

      const now = new Date();
      const nowLabel = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

      // Clip each event to today (handles events spanning midnight)
      const clipped = [];
      for (const ev of rawEvents) {
        const clip = clipEventToDay(ev, todayIso);
        if (!clip) continue;
        clipped.push({ ...ev, _clip: clip });
      }
      if (clipped.length === 0) {
        container.innerHTML = '<div class="empty-state">No events today</div>';
        return;
      }

      // Compute dynamic hour range from clipped start/end minutes
      let minHour = 7, maxHour = 22;
      for (const ev of clipped) {
        minHour = Math.min(minHour, Math.floor(ev._clip.startMin / 60));
        maxHour = Math.max(maxHour, Math.ceil(ev._clip.endMin / 60));
      }
      minHour = Math.max(0, minHour - 1);
      maxHour = Math.min(24, maxHour + 1);
      if (now.getHours() < minHour) minHour = Math.max(0, now.getHours());
      if (now.getHours() + 1 > maxHour) maxHour = Math.min(24, now.getHours() + 1);

      const PX_PER_MIN = 1; // 60px per hour
      const totalMinutes = (maxHour - minHour) * 60;
      const totalHeight = totalMinutes * PX_PER_MIN;

      // Hour labels
      let hoursHtml = '<div class="tl-hours">';
      for (let h = minHour; h < maxHour; h++) {
        const displayH = h % 24;
        const hr = displayH % 12 === 0 ? 12 : displayH % 12;
        const ampm = displayH < 12 ? 'AM' : 'PM';
        hoursHtml += '<div class="tl-hour" style="height: ' + (60 * PX_PER_MIN) + 'px;">' + hr + ' ' + ampm + '</div>';
      }
      hoursHtml += '</div>';

      // Sort by clipped start, assign lanes based on clipped intervals
      const sorted = clipped.slice().sort((a, b) => a._clip.startMin - b._clip.startMin);
      const active = [];
      for (const ev of sorted) {
        for (let i = active.length - 1; i >= 0; i--) {
          if (active[i]._clip.endMin <= ev._clip.startMin) active.splice(i, 1);
        }
        const used = new Set(active.map(e => e._lane));
        let lane = 0;
        while (used.has(lane)) lane++;
        ev._lane = lane;
        active.push(ev);
      }
      for (const ev of sorted) {
        let maxLane = 0;
        for (const other of sorted) {
          if (other._clip.startMin < ev._clip.endMin && other._clip.endMin > ev._clip.startMin) {
            maxLane = Math.max(maxLane, other._lane);
          }
        }
        ev._totalLanes = maxLane + 1;
      }

      // Events
      let eventsHtml = '';
      const dayStartMinutes = minHour * 60;
      for (const ev of sorted) {
        const top = Math.max(0, (ev._clip.startMin - dayStartMinutes) * PX_PER_MIN);
        const rawHeight = (ev._clip.endMin - ev._clip.startMin) * PX_PER_MIN;
        const height = Math.max(18, rawHeight);
        if (top > totalHeight) continue;
        const colorClass = ev.color_id ? 'gc-color-' + ev.color_id : 'gc-color-default';
        const isPast = ev._clip.origEnd < now;
        const pastClass = isPast ? ' past' : '';
        const routineClass = ev.routine ? ' routine' : '';
        const shortClass = rawHeight < 32 ? ' short' : '';
        const lanePct = 100 / ev._totalLanes;
        const leftPct = ev._lane * lanePct;
        const start = ev._clip.origStart.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const end = ev._clip.origEnd.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const title = (ev.summary || '(untitled)').replace(/</g, '&lt;');
        eventsHtml += '<div class="tl-event ' + colorClass + pastClass + routineClass + shortClass + '" '
          + 'style="top: ' + top + 'px; height: ' + height + 'px; left: calc(' + leftPct + '% + 2px); width: calc(' + lanePct + '% - 4px);">'
          + '<div class="tl-event-title">' + title + '</div>'
          + '<div class="tl-event-time">' + start + ' – ' + end + '</div>'
          + '</div>';
      }

      // Now line
      let nowLineHtml = '';
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const nowTop = (nowMin - dayStartMinutes) * PX_PER_MIN;
      if (nowTop >= 0 && nowTop <= totalHeight) {
        nowLineHtml = '<div class="tl-now-line" style="top: ' + nowTop + 'px;">'
          + '<div class="tl-now-label">' + nowLabel + '</div>'
          + '</div>';
      }

      container.innerHTML = '<div class="timeline" style="height: ' + totalHeight + 'px;">'
        + hoursHtml
        + '<div class="tl-grid">' + eventsHtml + nowLineHtml + '</div>'
        + '</div>';
    }

    function renderBrief(data) {
      const container = document.getElementById('briefContent');
      if (briefView === 'today') {
        renderTodayTimeline(data, container);
      } else {
        renderWeekTimeline(data, container);
      }
      updateBriefDate();
    }

    function clipEventToDay(ev, dayIso) {
      const dayStart = new Date(dayIso + 'T00:00:00');
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const evStart = new Date(ev.start);
      const evEnd = new Date(ev.end);
      if (evEnd <= dayStart || evStart >= dayEnd) return null;
      const clipStart = evStart < dayStart ? dayStart : evStart;
      const clipEnd = evEnd > dayEnd ? dayEnd : evEnd;
      return {
        startMin: Math.round((clipStart - dayStart) / 60000),
        endMin: Math.round((clipEnd - dayStart) / 60000),
        clippedStart: evStart < dayStart,
        clippedEnd: evEnd > dayEnd,
        origStart: evStart,
        origEnd: evEnd,
      };
    }

    function assignLanes(sorted) {
      const active = [];
      for (const ev of sorted) {
        const s = new Date(ev.start);
        for (let i = active.length - 1; i >= 0; i--) {
          if (new Date(active[i].end) <= s) active.splice(i, 1);
        }
        const used = new Set(active.map(e => e._lane));
        let lane = 0;
        while (used.has(lane)) lane++;
        ev._lane = lane;
        active.push(ev);
      }
      for (const ev of sorted) {
        const s = new Date(ev.start);
        const e = new Date(ev.end);
        let maxLane = 0;
        for (const other of sorted) {
          const os = new Date(other.start);
          const oe = new Date(other.end);
          if (os < e && oe > s) maxLane = Math.max(maxLane, other._lane);
        }
        ev._totalLanes = maxLane + 1;
      }
    }

    function renderWeekTimeline(data, container) {
      const weekEvents = (data.week_events || []).slice();
      // Include today's events so we have a full 7-day window starting today
      const todayIsoApi = data.brief?.date || new Date().toISOString().slice(0, 10);
      const todayEvents = (data.brief?.all_events || []).map(ev => ({ ...ev, day: todayIsoApi }));
      const allEvents = todayEvents.concat(weekEvents);

      if (allEvents.length === 0) {
        container.innerHTML = '<div class="empty-state">No events this week</div>';
        return;
      }

      const byDay = {};
      for (const ev of allEvents) {
        (byDay[ev.day] = byDay[ev.day] || []).push(ev);
      }

      // Build the 7-day window starting from today (using local date to avoid TZ drift)
      const todayLocal = new Date();
      const todayIso = todayLocal.getFullYear() + '-'
        + String(todayLocal.getMonth() + 1).padStart(2, '0') + '-'
        + String(todayLocal.getDate()).padStart(2, '0');
      const days = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(todayLocal.getFullYear(), todayLocal.getMonth(), todayLocal.getDate() + i);
        days.push(d.getFullYear() + '-'
          + String(d.getMonth() + 1).padStart(2, '0') + '-'
          + String(d.getDate()).padStart(2, '0'));
      }

      // Clip every event to its day and store on a per-day basis
      const clippedByDay = {};
      for (const day of days) {
        clippedByDay[day] = [];
        const rawList = byDay[day] || [];
        // Deduplicate by event id (same event may appear from today's brief and week_events)
        const seen = new Set();
        for (const ev of rawList) {
          const key = ev.id + '|' + day;
          if (seen.has(key)) continue;
          seen.add(key);
          const clip = clipEventToDay(ev, day);
          if (!clip) continue;
          clippedByDay[day].push({ ...ev, _clip: clip });
        }
      }

      // Compute global min/max hour from the clipped intervals
      let minHour = 7, maxHour = 22;
      for (const day of days) {
        for (const ev of clippedByDay[day]) {
          minHour = Math.min(minHour, Math.floor(ev._clip.startMin / 60));
          maxHour = Math.max(maxHour, Math.ceil(ev._clip.endMin / 60));
        }
      }
      minHour = Math.max(0, minHour - 1);
      maxHour = Math.min(24, maxHour + 1);

      const PX_PER_MIN = 1; // 60px per hour (matches daily view)
      const totalMinutes = (maxHour - minHour) * 60;
      const totalHeight = totalMinutes * PX_PER_MIN;
      const dayStartMinutes = minHour * 60;
      const now = new Date();

      // Headers row
      let headersHtml = '<div class="week-hours-header"></div>';
      for (const day of days) {
        const dateObj = new Date(day + 'T12:00:00');
        const dayName = dateObj.toLocaleDateString([], { weekday: 'short' });
        const dayNum = dateObj.getDate();
        const isToday = day === todayIso;
        headersHtml += '<div class="week-day-header' + (isToday ? ' today' : '') + '">'
          + dayName + '<span class="wd-num">' + dayNum + '</span>'
          + '</div>';
      }

      // Hour labels column
      let hoursHtml = '<div class="tl-hours" style="height: ' + totalHeight + 'px;">';
      for (let h = minHour; h < maxHour; h++) {
        const displayH = h % 24;
        const hr = displayH % 12 === 0 ? 12 : displayH % 12;
        const ampm = displayH < 12 ? 'AM' : 'PM';
        hoursHtml += '<div class="tl-hour" style="height: ' + (60 * PX_PER_MIN) + 'px;">' + hr + ' ' + ampm + '</div>';
      }
      hoursHtml += '</div>';

      // Day columns with events
      let daysHtml = '';
      for (const day of days) {
        const isToday = day === todayIso;
        const dayEvents = clippedByDay[day].slice().sort((a, b) => a._clip.startMin - b._clip.startMin);

        // Lane assignment on clipped intervals
        const active = [];
        for (const ev of dayEvents) {
          for (let i = active.length - 1; i >= 0; i--) {
            if (active[i]._clip.endMin <= ev._clip.startMin) active.splice(i, 1);
          }
          const used = new Set(active.map(e => e._lane));
          let lane = 0;
          while (used.has(lane)) lane++;
          ev._lane = lane;
          active.push(ev);
        }
        for (const ev of dayEvents) {
          let maxLane = 0;
          for (const other of dayEvents) {
            if (other._clip.startMin < ev._clip.endMin && other._clip.endMin > ev._clip.startMin) {
              maxLane = Math.max(maxLane, other._lane);
            }
          }
          ev._totalLanes = maxLane + 1;
        }

        let eventsHtml = '';
        for (const ev of dayEvents) {
          const top = Math.max(0, (ev._clip.startMin - dayStartMinutes) * PX_PER_MIN);
          const rawHeight = (ev._clip.endMin - ev._clip.startMin) * PX_PER_MIN;
          const height = Math.max(16, rawHeight);
          if (top > totalHeight) continue;
          const colorClass = ev.color_id ? 'gc-color-' + ev.color_id : 'gc-color-default';
          const isPast = ev._clip.origEnd < now;
          const pastClass = isPast ? ' past' : '';
          const routineClass = ev.routine ? ' routine' : '';
          const shortClass = rawHeight < 30 ? ' short' : '';
          const lanePct = 100 / ev._totalLanes;
          const leftPct = ev._lane * lanePct;
          const start = ev._clip.origStart.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          const end = ev._clip.origEnd.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          const title = (ev.summary || '(untitled)').replace(/</g, '&lt;');
          eventsHtml += '<div class="tl-event compact ' + colorClass + pastClass + routineClass + shortClass + '" '
            + 'style="top: ' + top + 'px; height: ' + height + 'px; left: calc(' + leftPct + '% + 1px); width: calc(' + lanePct + '% - 2px);">'
            + '<div class="tl-event-title">' + title + '</div>'
            + '<div class="tl-event-time-stack"><div>' + start + '</div><div>' + end + '</div></div>'
            + '</div>';
        }

        // Now-line in today's column
        let nowLineHtml = '';
        if (isToday) {
          const nowMin = now.getHours() * 60 + now.getMinutes();
          const nowTop = (nowMin - dayStartMinutes) * PX_PER_MIN;
          if (nowTop >= 0 && nowTop <= totalHeight) {
            nowLineHtml = '<div class="tl-now-line" style="top: ' + nowTop + 'px;"></div>';
          }
        }

        daysHtml += '<div class="week-day-col' + (isToday ? ' today' : '') + '" style="height: ' + totalHeight + 'px;">'
          + eventsHtml + nowLineHtml
          + '</div>';
      }

      container.innerHTML = '<div class="week-timeline">'
        + headersHtml
        + hoursHtml
        + daysHtml
        + '</div>';
    }

    function renderSlots(data) {
      const slotsToday = (data.slots_today || []).slice(0, 5);
      let slotsHtml = '';
      if (slotsToday.length > 0) {
        slotsHtml += '<div class="slots-list">';
        for (const slot of slotsToday) {
          const start = new Date(slot.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const end = new Date(slot.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const duration = formatDuration(slot.duration_minutes);
          slotsHtml += \`<div class="slot-item">
            <div>\${start} – \${end} (\${duration})</div>
          </div>\`;
        }
        slotsHtml += '</div>';
      } else {
        slotsHtml = '<div class="empty-state">No open slots today</div>';
      }
      document.getElementById('slotsContent').innerHTML = slotsHtml;
    }

    function renderBacklog(data) {
      const items = (data.backlog || []).slice();
      const stale = new Set((data.stale || []).map(i => i.id));
      if (items.length === 0) {
        document.getElementById('backlogContent').innerHTML = '<div class="empty-state">No backlog items</div>';
        return;
      }
      // Sort: high priority first, then oldest created first
      const rank = { high: 0, medium: 1, low: 2 };
      items.sort((a, b) => {
        const pr = (rank[a.priority] ?? 99) - (rank[b.priority] ?? 99);
        if (pr !== 0) return pr;
        return new Date(a.created) - new Date(b.created);
      });
      let html = '<div class="backlog-list">';
      for (const item of items) {
        const priClass = 'priority-' + item.priority;
        const isStale = stale.has(item.id);
        const ageDays = Math.floor((Date.now() - new Date(item.created).getTime()) / 86400000);
        let badges = '';
        if (isStale) badges += '<span class="badge stale">stale</span>';
        badges += '<span class="badge">' + item.energy + '</span>';
        badges += '<span class="badge">' + item.estimate_minutes + 'm</span>';
        badges += '<span class="badge">' + ageDays + 'd old</span>';
        for (const tag of (item.tags || [])) {
          badges += '<span class="badge tag">#' + tag + '</span>';
        }
        html += \`<div class="backlog-item">
          <div style="flex: 1; min-width: 0;">
            <div class="backlog-title"><span class="\${priClass}">●</span> \${item.title}</div>
            <div class="backlog-badges">\${badges}</div>
          </div>
          <div class="backlog-actions">
            <button class="action-btn" title="Slot it" onclick="openSlotModal('\${item.id}')">⏰</button>
            <button class="action-btn" title="Done" onclick="markDone('\${item.id}')">✓</button>
            <button class="action-btn" title="Drop" onclick="markDropped('\${item.id}')">✗</button>
          </div>
        </div>\`;
      }
      html += '</div>';
      document.getElementById('backlogContent').innerHTML = html;
    }

    function renderAll(data) {
      renderBrief(data);
      renderSlots(data);
      renderBacklog(data);
    }

    async function loadDashboard(forceNetwork = false) {
      // 1. Render cached immediately if available and not forcing
      if (!forceNetwork) {
        const cached = loadFromCache();
        if (cached) {
          lastState = cached;
          renderAll(cached);
          const genAt = cached.generated_at ? new Date(cached.generated_at) : null;
          if (genAt) document.getElementById('lastUpdated').textContent = genAt.toLocaleTimeString() + ' (cached)';
        }
      }
      // 2. Fetch fresh in background
      const btn = document.getElementById('refreshBtn');
      if (btn) btn.classList.add('refreshing');
      try {
        const resp = await fetch('/api/calendar/state');
        const data = await resp.json();
        if (data.error) {
          document.getElementById('briefContent').innerHTML = \`<div class="empty-state">Error: \${data.error}</div>\`;
          return;
        }
        lastState = data;
        saveToCache(data);
        renderAll(data);
        document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
        // Reset cooldown on successful refresh
        calendarLastRefreshAt = Date.now();
      } catch (error) {
        console.error('Load failed:', error);
        if (!lastState) document.getElementById('briefContent').innerHTML = '<div class="empty-state">Failed to load</div>';
      } finally {
        if (btn) btn.classList.remove('refreshing');
      }
    }

    async function refreshDashboard() {
      await loadDashboard(true);
    }

    async function sendQuickAsk() {
      const input = document.getElementById('quickAskInput');
      const prompt = input.value.trim();
      if (!prompt) return;

      try {
        const resp = await fetch('/api/agents/spawn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dialId: 'calendar_manager', initialPrompt: prompt })
        });
        const result = await resp.json();
        if (result.ok) {
          input.value = '';
          console.log('Agent spawned');
        }
      } catch (error) {
        console.error('Send failed:', error);
      }
    }

    function toggleBacklogForm() {
      const form = document.getElementById('backlogForm');
      form.classList.toggle('open');
      if (form.classList.contains('open')) {
        document.getElementById('bfTitle').focus();
      }
    }

    async function submitBacklogForm(ev) {
      ev.preventDefault();
      const title = document.getElementById('bfTitle').value.trim();
      if (!title) return;
      const tagsRaw = document.getElementById('bfTags').value.trim();
      const body = {
        title,
        priority: document.getElementById('bfPriority').value,
        energy: document.getElementById('bfEnergy').value,
        estimate_minutes: parseInt(document.getElementById('bfEstimate').value, 10) || 30,
        tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
        notes: document.getElementById('bfNotes').value.trim(),
      };
      try {
        const resp = await fetch('/api/calendar/backlog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await resp.json();
        if (result.ok) {
          document.getElementById('backlogForm').reset();
          document.getElementById('bfPriority').value = 'medium';
          document.getElementById('bfEnergy').value = 'any';
          document.getElementById('bfEstimate').value = '30';
          toggleBacklogForm();
          await loadDashboard(true);
        } else {
          alert('Add failed: ' + (result.error || 'unknown'));
        }
      } catch (e) {
        alert('Add failed: ' + e.message);
      }
    }

    let slotModalItem = null;

    function openSlotModal(itemId) {
      if (!lastState) return;
      const item = (lastState.backlog || []).find(i => i.id === itemId);
      if (!item) return;
      slotModalItem = item;
      document.getElementById('slotModalSubtitle').textContent =
        item.title + ' · needs ' + item.estimate_minutes + 'm';
      const body = document.getElementById('slotModalBody');
      const needed = item.estimate_minutes;

      // Group slots by day: today first, then week
      const groups = [];
      if ((lastState.slots_today || []).length > 0) {
        groups.push({ label: 'Today', slots: lastState.slots_today.map(s => ({ ...s, day: new Date(s.start).toISOString().slice(0,10) })) });
      }
      const weekByDay = {};
      for (const s of (lastState.slots_week || [])) {
        (weekByDay[s.day] = weekByDay[s.day] || []).push(s);
      }
      for (const day of Object.keys(weekByDay).sort()) {
        const dateObj = new Date(day + 'T12:00:00');
        groups.push({ label: dateObj.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }), slots: weekByDay[day] });
      }

      if (groups.length === 0) {
        body.innerHTML = '<div class="empty-state">No open slots available</div>';
      } else {
        let html = '';
        for (const g of groups) {
          html += \`<div class="slot-day-header">\${g.label}</div>\`;
          for (const slot of g.slots) {
            const start = new Date(slot.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = new Date(slot.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const fits = slot.duration_minutes >= needed;
            const klass = fits ? 'slot-option' : 'slot-option too-short';
            const onClick = fits ? \`onclick="confirmSlot('\${slot.start}', this)"\` : '';
            html += \`<div class="\${klass}" \${onClick}>
              <span>\${start} – \${end}</span>
              <span style="color: #7e8e91; font-size: 11px;">\${formatDuration(slot.duration_minutes)}</span>
            </div>\`;
          }
        }
        body.innerHTML = html;
      }

      document.getElementById('slotModal').classList.add('open');
    }

    function closeSlotModal() {
      document.getElementById('slotModal').classList.remove('open');
      slotModalItem = null;
    }

    async function confirmSlot(slotStartIso, btn) {
      if (!slotModalItem) return;
      const start = new Date(slotStartIso);
      const end = new Date(start.getTime() + slotModalItem.estimate_minutes * 60000);
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.5';
      try {
        const resp = await fetch('/api/calendar/backlog/' + slotModalItem.id + '/slot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start: start.toISOString(), end: end.toISOString() }),
        });
        const result = await resp.json();
        if (result.ok) {
          closeSlotModal();
          await loadDashboard(true);
        } else {
          alert('Slot failed: ' + (result.error || 'unknown'));
          btn.style.pointerEvents = '';
          btn.style.opacity = '';
        }
      } catch (e) {
        alert('Slot failed: ' + e.message);
        btn.style.pointerEvents = '';
        btn.style.opacity = '';
      }
    }

    async function markDone(itemId) {
      try {
        await fetch('/api/calendar/backlog/' + itemId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'done' })
        });
        loadDashboard();
      } catch (error) {
        console.error('Mark done failed:', error);
      }
    }

    async function markDropped(itemId) {
      try {
        await fetch('/api/calendar/backlog/' + itemId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'drop' })
        });
        loadDashboard();
      } catch (error) {
        console.error('Mark dropped failed:', error);
      }
    }

    // Paint cached state instantly, then fetch fresh in background
    loadDashboard();

    // Bind the refresh cooldown ticker (every 1 second check, auto-refresh every 1 minute)
    bindCalendarRefreshTicker();

    // Re-fetch when tab regains focus
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadDashboard();
    });

    // Update now-line every minute for today view
    setInterval(() => {
      if (briefView === 'today' && lastState) {
        renderBrief(lastState);
      }
    }, 60000);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/') {
    html(res, 200, renderPage());
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    const rel = url.pathname.replace(/^\/assets\//, '');
    const fullPath = path.normalize(path.join(__dirname, 'assets', rel));
    const assetsRoot = path.normalize(path.join(__dirname, 'assets') + path.sep);
    if (!fullPath.startsWith(assetsRoot)) {
      json(res, 400, { error: 'invalid asset path' });
      return;
    }
    try {
      const [data, stat] = await Promise.all([fs.readFile(fullPath), fs.stat(fullPath)]);
      const ext = path.extname(fullPath).toLowerCase();
      const mime =
        ext === '.svg'
          ? 'image/svg+xml'
          : ext === '.css'
            ? 'text/css'
              : ext === '.js'
                ? 'text/javascript'
                : ext === '.json'
                  ? 'application/json; charset=utf-8'
                : ext === '.png'
                  ? 'image/png'
                : ext === '.jpg' || ext === '.jpeg'
                  ? 'image/jpeg'
                  : ext === '.webp'
                    ? 'image/webp'
                    : ext === '.gif'
                      ? 'image/gif'
                      : 'application/octet-stream';
      const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
      const lastModified = stat.mtime.toUTCString();
      const ifNoneMatch = req.headers['if-none-match'];
      const ifModifiedSince = req.headers['if-modified-since'];
      if (ifNoneMatch === etag || (ifModifiedSince && new Date(ifModifiedSince).getTime() >= stat.mtime.getTime())) {
        res.writeHead(304, {
          ETag: etag,
          'Last-Modified': lastModified,
          'Cache-Control': 'public, max-age=3600, must-revalidate',
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=3600, must-revalidate',
        ETag: etag,
        'Last-Modified': lastModified,
        'Content-Length': data.length,
      });
      res.end(data);
    } catch {
      json(res, 404, { error: 'asset not found' });
    }
    return;
  }

  if (url.pathname === '/calendar') {
    html(res, 200, renderCalendarPage());
    return;
  }

  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const usage = getUsageSnapshot();
    json(res, 200, usage);
    return;
  }

  if (url.pathname === '/api/usage/refresh' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const provider = String(body.provider || '').trim().toLowerCase();
      const force = body.force !== false;
      if (!PROVIDERS.has(provider)) {
        json(res, 400, { error: 'valid provider is required' });
        return;
      }
      const usage = await refreshSingleProviderInBackground(provider, { force });
      json(res, 200, { ok: true, provider, usage });
    } catch (error) {
      json(res, 500, { error: error.message || 'usage refresh failed' });
    }
    return;
  }

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const [sessions, recentWorkdirs] = await Promise.all([getMergedSessions(), readRecentWorkdirsFromState()]);
    json(res, 200, { sessions, recentWorkdirs, fetchedAt: new Date().toISOString() });
    return;
  }

  if (url.pathname === '/api/directories' && req.method === 'GET') {
    try {
      const requestedPath = String(url.searchParams.get('path') || '').trim();
      const listing = await listDirectoryOptions(requestedPath || HOME_DIRECTORY);
      json(res, 200, listing);
    } catch (error) {
      json(res, 400, { error: error.message || 'directory lookup failed' });
    }
    return;
  }

  if (url.pathname === '/api/sessions/spawn' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) {
        json(res, 400, { error: 'name is required' });
        return;
      }
      const provider = normalizeProvider(body.provider);
      const hasTemplate = typeof body.templateId === 'string' && body.templateId.trim();
      const templateId = hasTemplate ? normalizeTemplateId(body.templateId, TEMPLATE_NEW_BRAINSTORM) : undefined;
      const workdir = typeof body.workdir === 'string' ? body.workdir : '';
      const personaId = typeof body.personaId === 'string' && body.personaId.trim() ? normalizePersonaId(body.personaId, PERSONA_NONE) : undefined;
      await spawnSlotByName(name, { provider, templateId, workdir, personaId });
      json(res, 200, { ok: true, name });
    } catch (error) {
      const message = error.message || 'spawn failed';
      const status = message.includes('workdir') || message.includes('directory') || message.includes('session not found') ? 400 : 500;
      json(res, status, { error: message });
    }
    return;
  }

  if (url.pathname === '/api/agents/spawn' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const dialId = String(body.dialId || '').trim();
      if (!dialId) {
        json(res, 400, { error: 'dialId is required' });
        return;
      }
      const provider = normalizeProvider(body.provider);
      const initialPrompt = typeof body.initialPrompt === 'string' && body.initialPrompt.trim() ? body.initialPrompt.trim() : null;
      const launched = await launchHotDialAgent(dialId, provider, initialPrompt);
      json(res, 200, { ok: true, ...launched });
    } catch (error) {
      const message = error.message || 'agent launch failed';
      const status = message.includes('unknown hot dial agent') || message.includes('idle scientist slots') ? 400 : 500;
      json(res, status, { error: message });
    }
    return;
  }

  if (url.pathname === '/api/sessions/kill' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) {
        json(res, 400, { error: 'name is required' });
        return;
      }
      await killSlotByName(name);
      json(res, 200, { ok: true, name });
    } catch (error) {
      json(res, 500, { error: error.message || 'kill failed' });
    }
    return;
  }

  if (url.pathname === '/api/sessions/update' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) {
        json(res, 400, { error: 'name is required' });
        return;
      }
      await updateSlotMeta(name, body);
      json(res, 200, { ok: true, name });
    } catch (error) {
      json(res, 500, { error: error.message || 'update failed' });
    }
    return;
  }

  if (url.pathname === '/api/profiles' && req.method === 'GET') {
    try {
      const catalog = readProfilesJson();
      const now = Date.now();
      const cooldowns = listCooldowns({ nowMs: now });
      const cooldownByAlias = new Map();
      for (const c of cooldowns) {
        if (c.alias) cooldownByAlias.set(c.alias, c);
      }
      const profiles = Object.entries(catalog.profiles || {}).map(([alias, meta]) => {
        const rawCache =
          meta?.usageCache && typeof meta.usageCache === 'object'
            ? { ...meta.usageCache }
            : emptyProfileUsageCache(meta?.email || null);
        // Profile email is authoritative per alias; avoid stale cache email bleed.
        if (meta?.email) rawCache.accountEmail = meta.email;
        const isActive = catalog.active === alias;
        const staleness = computeProfileStaleness(alias, { now, isActive });
        const cooldown = cooldownByAlias.get(alias) || null;
        // Needs-recovery = this alias has a cooldown OR its last stored
        // refresh attempt ended fatally. UI can badge these as "Recover".
        const needsRecovery = !!cooldown;
        return {
          alias,
          displayName: meta.displayName || alias,
          email: meta.email || null,
          subscriptionType: meta?.authState?.authStatus?.subscriptionType || null,
          createdAt: meta.createdAt || null,
          usageCache: decorateUsageWindows(rawCache, ['5-hour', 'weekly']),
          credStaleness: staleness,
          refreshCooldown: cooldown
            ? {
                until: cooldown.cooldownUntil,
                remainingMs: Math.max(0, Date.parse(cooldown.cooldownUntil) - now),
                lastError: cooldown.error || null,
              }
            : null,
          needsRecovery,
          recoveryCommand: needsRecovery ? `atc-profile rotate ${alias}` : null,
        };
      });
      json(res, 200, { active: catalog.active, profiles });
    } catch (error) {
      json(res, 500, { error: error.message || 'profiles read failed' });
    }
    return;
  }

  if (url.pathname === '/api/credential-events' && req.method === 'GET') {
    try {
      const alias = url.searchParams.get('alias') || null;
      const sinceParam = url.searchParams.get('since') || null;
      const limitParam = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;
      const sinceMs = sinceParam ? Date.parse(sinceParam) : null;
      const events = tailCredentialEvents({
        alias,
        sinceMs: Number.isFinite(sinceMs) ? sinceMs : null,
        limit,
      });
      json(res, 200, { events });
    } catch (error) {
      json(res, 500, { error: error.message || 'event log read failed' });
    }
    return;
  }

  if (url.pathname === '/api/profiles/switch' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const alias = String(body.alias || '').trim();
      if (!alias) {
        json(res, 400, { error: 'alias is required' });
        return;
      }
      const catalog = readProfilesJson();
      if (!catalog.profiles[alias]) {
        json(res, 400, { error: `Unknown profile "${alias}"` });
        return;
      }
      // Shell out to atc-profile use <alias> so the UI follows the same
      // path as manual CLI account validation before refreshing usage.
      const atcProfilePath = path.join(__dirname, 'scripts', 'atc-profile.mjs');
      const result = await runCommand('node', [atcProfilePath, 'use', alias], 30000);
      if (!result.ok) {
        json(res, 500, { error: result.stderr || 'Profile switch failed' });
        return;
      }
      // Invalidate the cache entirely — the previous value belonged to a
      // different Claude account, so keeping it around causes the home-page
      // card (plan, windows, email) to render the OUTGOING account until the
      // background refresh completes. Paired with { force: { claude: true } },
      // this guarantees the next /api/usage response the frontend poller sees
      // is either loading=true (still fetching) or fresh for the NEW account,
      // never stale-but-throttled for the outgoing one.
      usageCache = { value: null, fetchedAt: 0, pending: null };
      refreshUsageSummaryInBackground({ force: { claude: true } }).catch(() => {});
      json(res, 200, { ok: true, active: alias });
    } catch (error) {
      json(res, 500, { error: error.message || 'switch failed' });
    }
    return;
  }

  if (url.pathname === '/api/calendar/state' && req.method === 'GET') {
    try {
      const result = await runCalendarPython(['scripts/dashboard_state.py']);
      if (!result.ok) {
        json(res, 500, { error: result.stderr || 'dashboard state generation failed' });
        return;
      }
      const state = JSON.parse(result.stdout);
      json(res, 200, state);
    } catch (error) {
      json(res, 500, { error: error.message || 'calendar state failed' });
    }
    return;
  }

  if (url.pathname === '/api/calendar/backlog' && req.method === 'GET') {
    try {
      const status = String(url.searchParams.get('status') || '').trim();
      const stale = url.searchParams.get('stale') ? Number(url.searchParams.get('stale')) : null;
      const args = ['scripts/backlog.py', 'ls', '--json'];
      if (status) args.push('--status', status);
      if (stale) args.push('--stale', String(stale));
      const result = await runCalendarPython(args);
      if (!result.ok) {
        json(res, 500, { error: result.stderr || 'backlog list failed' });
        return;
      }
      const items = JSON.parse(result.stdout);
      json(res, 200, { items });
    } catch (error) {
      json(res, 500, { error: error.message || 'backlog list failed' });
    }
    return;
  }

  if (url.pathname === '/api/calendar/backlog' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      if (!title) {
        json(res, 400, { error: 'title is required' });
        return;
      }
      const args = ['scripts/backlog.py', 'add', title, '--json'];
      if (body.priority) args.push('--priority', String(body.priority));
      if (body.energy) args.push('--energy', String(body.energy));
      if (body.estimate_minutes) args.push('--estimate', String(body.estimate_minutes));
      if (body.tags && Array.isArray(body.tags)) {
        for (const tag of body.tags) {
          args.push('--tag', String(tag));
        }
      }
      if (body.notes) args.push('--notes', String(body.notes));
      const result = await runCalendarPython(args);
      if (!result.ok) {
        json(res, 500, { error: result.stderr || 'backlog add failed' });
        return;
      }
      const item = JSON.parse(result.stdout);
      json(res, 200, { ok: true, item });
    } catch (error) {
      json(res, 500, { error: error.message || 'backlog add failed' });
    }
    return;
  }

  if (url.pathname.startsWith('/api/calendar/backlog/') && req.method === 'PATCH') {
    try {
      const itemId = url.pathname.split('/').pop();
      const body = await readJsonBody(req);
      const action = String(body.action || '').trim();
      if (!action) {
        json(res, 400, { error: 'action is required (done|drop|update)' });
        return;
      }
      const args = ['scripts/backlog.py', action, itemId, '--json'];
      if (action === 'update') {
        if (body.title) args.push('--title', String(body.title));
        if (body.priority) args.push('--priority', String(body.priority));
        if (body.status) args.push('--status', String(body.status));
      }
      const result = await runCalendarPython(args);
      if (!result.ok) {
        json(res, 500, { error: result.stderr || `backlog ${action} failed` });
        return;
      }
      const item = JSON.parse(result.stdout);
      json(res, 200, { ok: true, item });
    } catch (error) {
      json(res, 500, { error: error.message || 'backlog action failed' });
    }
    return;
  }

  if (url.pathname.includes('/api/calendar/backlog/') && url.pathname.includes('/slot') && req.method === 'POST') {
    try {
      const parts = url.pathname.split('/');
      const itemId = parts[parts.indexOf('backlog') + 1];
      const body = await readJsonBody(req);
      const start = String(body.start || '').trim();
      const end = String(body.end || '').trim();
      if (!start || !end) {
        json(res, 400, { error: 'start and end times are required' });
        return;
      }
      const result = await runCalendarPython(['scripts/slot_backlog_item.py', itemId, start, end, '--json']);
      if (!result.ok) {
        json(res, 500, { error: result.stderr || 'slot creation failed' });
        return;
      }
      const slotResult = JSON.parse(result.stdout);
      json(res, 200, slotResult);
    } catch (error) {
      json(res, 500, { error: error.message || 'slot creation failed' });
    }
    return;
  }

  json(res, 404, { error: 'not found' });
});

// CSS is loaded from the source file at startup so it can be edited independently.
let DASHBOARD_CSS = '';
async function loadDashboardCss() {
  try {
    DASHBOARD_CSS = await fs.readFile(path.join(__dirname, 'assets', 'css', 'dashboard.css'), 'utf8');
  } catch {
    // fallback: leave empty (page will render without styles)
  }
}

async function startDashboardServer() {
  loadUsageRateCacheFromDisk();
  usageCache = { value: buildBootUsageSummaryFromCaches(), fetchedAt: 0, pending: null };
  await Promise.all([loadState(), loadDashboardCss()]);
  await ingestTelemetry().catch(() => {});
  refreshUsageSummaryInBackground().catch(() => {});
  // Start the credential watcher: fs.watch on ~/.claude.json + safety poll
  // keep <active>.cred in lockstep with keychain rotations, so a switch-back
  // never loads a single-use-consumed refresh token. No-op on non-darwin.
  try {
    startCredentialWatcher();
  } catch {
    // non-fatal — event log records the failure
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`dashboard listening on http://0.0.0.0:${PORT}`);
  });

  setInterval(() => {
    ingestTelemetry().catch(() => {});
  }, TELEMETRY_INGEST_MS);

  // Title updates are handled by Gemini writing to sessions-state.json directly;
  // the dashboard picks them up on the next ingestTelemetry cycle.
}

if (process.env.DASHBOARD_TEST_IMPORT !== '1') {
  await startDashboardServer();
}

export {
  ago,
  buildProviderLaunchCommand,
  durationSince,
  fetchCodexbarUsage,
  normalizePersonaId,
  normalizePersonaForTemplate,
  personaConfig,
  personaIdsForTemplate,
  PERSONA_CONFIGS,
  selectLastInteractionAtFromOutput,
};
