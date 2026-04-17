#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.DASHBOARD_PORT || 1111);
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.join(__dirname, 'sessions.json');
const STATE_FILE = process.env.SESSIONS_STATE_FILE || path.join(__dirname, 'state', 'sessions-state.json');
const RUN_DIR = process.env.SESSIONS_RUN_DIR || path.join(__dirname, 'run');
const RUNTIME_DIR = process.env.SESSIONS_RUNTIME_DIR || path.join(__dirname, 'runtime');
const REPO_ROOT = path.join(__dirname, '..');
const PERSONAS_DIR = path.join(REPO_ROOT, 'personas');
const PROFILES_DIR = path.join(process.env.HOME || '', '.claude-profiles');
const PROFILES_JSON = path.join(PROFILES_DIR, 'profiles.json');
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

// ── Profile management (Claude multi-account switching) ────────────────────

function readProfilesJson() {
  try {
    const text = fsSync.readFileSync(PROFILES_JSON, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, active: null, profiles: {} };
  } catch {
    return { version: 1, active: null, profiles: {} };
  }
}

function getActiveProfile() {
  const catalog = readProfilesJson();
  return catalog.active || null;
}

let usageCache = { value: null, fetchedAt: 0, pending: null };

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

function formatCountdown(targetIso) {
  if (!targetIso) return 'n/a';
  const target = new Date(targetIso).getTime();
  if (!Number.isFinite(target)) return 'n/a';
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

async function fetchCodexbarUsage(provider, source = 'auto', runCommandFn = runCommand) {
  if (DISABLE_CODEX_BAR) {
    return { ok: false, error: 'Codex Bar disabled', provider };
  }

  const parseResult = (raw) => {
    let parsed = null;
    if (raw?.stdout && String(raw.stdout).trim()) {
      try {
        parsed = JSON.parse(raw.stdout);
      } catch {
        parsed = null;
      }
    }

    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    if (root && typeof root === 'object') {
      if (root.error) return { ok: false, error: root.error.message || 'provider error', provider };

      const usage = root.usage || null;
      const dashboard = root.openaiDashboard || null;
      const primary = usage?.primary || dashboard?.primaryLimit || null;
      const secondary = usage?.secondary || dashboard?.secondaryLimit || null;

      return {
        ok: true,
        provider: (provider || '').toLowerCase(),
        source: root.source || source || 'auto',
        plan: usage?.loginMethod || dashboard?.accountPlan || null,
        primary: parseWindow(primary),
        secondary: parseWindow(secondary),
        updatedAt: usage?.updatedAt || null,
        fetchedAt: new Date().toISOString(),
      };
    }

    if (!raw?.ok) return { ok: false, error: raw?.stderr || 'codexbar usage failed', provider };
    return { ok: false, error: 'codexbar returned empty payload', provider };
  };

  const shouldAttemptGeminiRefresh = (errorMessage) => {
    if (String(provider || '').toLowerCase() !== 'gemini') return false;
    const msg = String(errorMessage || '').toLowerCase();
    return (
      msg.includes('could not extract oauth credentials from gemini cli') ||
      msg.includes('could not find gemini cli oauth configuration')
    );
  };

  const args = ['usage', '--provider', provider, '--format', 'json'];
  if (source) args.push('--source', source);
  const raw = await runCommandFn('codexbar', args);
  let result = parseResult(raw);

  if (shouldAttemptGeminiRefresh(result.error)) {
    // Gemini CLI refreshes ~/.gemini/oauth_creds.json when invoked.
    const refresh = await runCommandFn('gemini', ['-p', 'ok', '--output-format', 'json'], 25000);
    if (refresh.ok) {
      const retriedRaw = await runCommandFn('codexbar', args);
      result = parseResult(retriedRaw);
      if (result.ok) return { ...result, recoveredViaGeminiRefresh: true };
    }
  }

  return result;
}

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

function refreshUsageSummaryInBackground() {
  if (usageCache.pending) return usageCache.pending;
  usageCache.pending = (async () => {
    try {
      const [codexRaw, claudeRaw, geminiRaw] = await Promise.all([
        fetchCodexbarUsage('codex', 'cli'),
        fetchCodexbarUsage('claude', 'web'),
        fetchCodexbarUsage('gemini', 'auto'),
      ]);

      const value = {
        fetchedAt: new Date().toISOString(),
        codex: decorateUsageWindows(codexRaw, ['5-hour', 'weekly']),
        claude: decorateUsageWindows(claudeRaw, ['5-hour', 'weekly']),
        gemini: decorateUsageWindows(geminiRaw, ['24h primary', '24h secondary']),
      };
      usageCache = { value, fetchedAt: Date.now(), pending: null };
      return value;
    } catch (error) {
      const fallback = usageCache.value || errorUsageSummary(error?.message || 'Usage unavailable');
      usageCache = { value: fallback, fetchedAt: Date.now(), pending: null };
      return fallback;
    }
  })();
  return usageCache.pending;
}

function getUsageSnapshot() {
  const now = Date.now();
  if (usageCache.value && now - usageCache.fetchedAt < USAGE_TTL_MS) {
    return { ...usageCache.value, activeProfile: getActiveProfile() };
  }
  refreshUsageSummaryInBackground();
  return { ...(usageCache.value || loadingUsageSummary()), activeProfile: getActiveProfile() };
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

async function launchHotDialAgent(dialId, provider) {
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
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <div class="shell">
    <section class="title-wrap">
      <h1 class="title"><span class="decor">🗼</span><span class="accent">AI Traffic Control</span><span class="decor">💻</span></h1>
    </section>

    <section class="panel">
      <div class="usage-stack" id="usage-grid"></div>
    </section>

    <section style="margin-top:8px;">
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
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="agent-cancel">Cancel</button>
        <button type="button" class="btn-primary" id="agent-confirm">Launch agent</button>
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
    const usageExpanded = new Set();
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

    function windowCard(windowInfo) {
      if (!windowInfo) return '<article class="window missing">No data</article>';
      const pct = clampPct(windowInfo.usedPercent);
      return '<article class="window">' +
        '<div class="window-head">' +
          '<div class="window-label">' + esc(windowInfo.label || 'window') + '</div>' +
          '<div class="window-value" style="color:' + pctColor(pct) + ';">' + esc(Math.round(pct) + '%') + '</div>' +
        '</div>' +
        '<div class="window-reset">Reset in ' + esc(windowInfo.resetIn || 'n/a') + '</div>' +
        '<div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '</article>';
    }

    function providerUsageRow(providerKey, title, payload, activeProfile, allProfiles) {
      const logo = PROVIDER_LOGOS[providerKey] || '';
      const isExpanded = usageExpanded.has(providerKey);
      const hasProfiles = providerKey === 'claude' && Array.isArray(allProfiles) && allProfiles.length > 1;
      if (payload && payload.loading) {
        return '<article class="usage-row loading">' +
          '<button type="button" class="usage-toggle" data-toggle-provider="' + esc(providerKey) + '" aria-expanded="false" aria-label="Toggle ' + esc(title) + ' details">' +
            '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>' +
          '</button>' +
          '<div class="provider">' +
            '<img class="provider-logo" src="' + esc(logo) + '" alt="' + esc(title) + ' logo" loading="lazy" width="78" height="78" />' +
            '<div class="provider-name-wrap"><div class="provider-name">' + esc(title) + ' <span class="provider-plan-inline">(Loading)</span></div><div class="provider-plan-block">Loading</div></div>' +
          '</div>' +
          '<div class="usage-loading"><span class="usage-spinner" aria-hidden="true"></span><span>Loading usage…</span></div>' +
        '</article>';
      }
      if (!payload || !payload.ok) {
        return '<article class="usage-row error">' +
          '<button type="button" class="usage-toggle" data-toggle-provider="' + esc(providerKey) + '" aria-expanded="false" aria-label="Toggle ' + esc(title) + ' details">' +
            '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>' +
          '</button>' +
          '<div class="provider">' +
            '<img class="provider-logo" src="' + esc(logo) + '" alt="' + esc(title) + ' logo" loading="lazy" width="78" height="78" />' +
            '<div class="provider-name-wrap"><div class="provider-name">' + esc(title) + ' <span class="provider-plan-inline">(Unavailable)</span></div><div class="provider-plan-block">Unavailable</div></div>' +
          '</div>' +
          '<div class="usage-error">' + esc(payload?.error || 'Usage unavailable') + '</div>' +
        '</article>';
      }

      const plan = compactPlan(payload.plan || 'connected');
      return '<article class="usage-row ' + (isExpanded ? 'expanded' : '') + '" data-provider="' + esc(providerKey) + '">' +
        '<button type="button" class="usage-toggle" data-toggle-provider="' + esc(providerKey) + '" aria-expanded="' + (isExpanded ? 'true' : 'false') + '" aria-label="Toggle ' + esc(title) + ' details">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>' +
        '</button>' +
        '<div class="provider">' +
          '<img class="provider-logo" src="' + esc(logo) + '" alt="' + esc(title) + ' logo" loading="lazy" width="78" height="78" />' +
          '<div class="provider-name-wrap">' +
            '<div class="provider-name">' + esc(title) + ' <span class="provider-plan-inline">(' + esc(plan) + ')</span>' +
            (hasProfiles && activeProfile ? ' <span class="profile-alias">[' + esc(activeProfile) + ']</span>' : '') +
            '</div>' +
            '<div class="provider-plan-block">' + esc(plan) + '</div>' +
            '<div class="provider-mini">' +
              miniWindow(payload.primary) +
              miniWindow(payload.secondary) +
            '</div>' +
          '</div>' +
          (hasProfiles ? '<div class="profile-nav"><button class="profile-prev" type="button" aria-label="Previous profile" title="Previous profile">‹</button><button class="profile-next" type="button" aria-label="Next profile" title="Next profile">›</button></div>' : '') +
        '</div>' +
        '<div class="usage-details">' +
          '<div class="windows">' +
            windowCard(payload.primary) +
            windowCard(payload.secondary) +
          '</div>' +
        '</div>' +
      '</article>';
    }

    function bindUsageInteractions() {
      const toggles = document.querySelectorAll('[data-toggle-provider]');
      for (const btn of toggles) {
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          const provider = btn.getAttribute('data-toggle-provider');
          if (!provider) return;
          if (usageExpanded.has(provider)) usageExpanded.delete(provider);
          else usageExpanded.add(provider);
          refresh().catch(function () {});
        });
      }
    }

    function bindProfileInteractions() {
      const claudeRow = document.querySelector('.usage-row[data-provider="claude"]');
      if (!claudeRow) return;
      const prevBtn = claudeRow.querySelector('.profile-prev');
      const nextBtn = claudeRow.querySelector('.profile-next');
      if (!prevBtn || !nextBtn) return;
      function getNextProfileAlias(direction) {
        if (!latestProfiles || latestProfiles.length < 2) return null;
        const current = latestProfiles.findIndex(p => p.alias === latestUsage.activeProfile);
        if (current < 0) return null;
        const next = current + direction;
        if (next < 0) return latestProfiles[latestProfiles.length - 1]?.alias;
        if (next >= latestProfiles.length) return latestProfiles[0]?.alias;
        return latestProfiles[next]?.alias;
      }
      function switchProfile(direction) {
        const nextAlias = getNextProfileAlias(direction);
        if (!nextAlias) return;
        switchProfileTo(nextAlias);
      }
      prevBtn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); switchProfile(-1); });
      nextBtn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); switchProfile(1); });
      bindProviderSwipeCard(claudeRow, (direction) => switchProfile(direction > 0 ? 1 : -1));
    }

    function bindProviderSwipeCard(card, onSwipe) {
      let touchStart = 0;
      let touchEnd = 0;
      const threshold = 35;
      card.style.touchAction = 'pan-y';
      card.addEventListener('touchstart', (e) => { touchStart = e.changedTouches[0].clientX; });
      card.addEventListener('touchend', (e) => {
        touchEnd = e.changedTouches[0].clientX;
        const diff = touchStart - touchEnd;
        if (Math.abs(diff) > threshold) onSwipe(diff);
      });
    }

    async function switchProfileTo(alias) {
      const claudeRow = document.querySelector('.usage-row[data-provider="claude"]');
      if (!claudeRow) return;
      claudeRow.classList.add('switching');
      const aliasSpan = claudeRow.querySelector('.profile-alias');
      const originalText = aliasSpan?.textContent || '';
      if (aliasSpan) aliasSpan.textContent = '[' + alias + ']';
      const detailsDiv = claudeRow.querySelector('.usage-details');
      if (detailsDiv) detailsDiv.style.opacity = '0.5';
      try {
        const resp = await fetch('/api/profiles/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alias }),
        });
        if (!resp.ok) {
          if (aliasSpan) aliasSpan.textContent = originalText;
          if (detailsDiv) detailsDiv.style.opacity = '1';
          claudeRow.classList.remove('switching');
          return;
        }
        let attempts = 0;
        const maxAttempts = 30;
        function pollUsage() {
          if (attempts >= maxAttempts) {
            claudeRow.classList.remove('switching');
            refresh().catch(() => {});
            return;
          }
          fetch('/api/usage').then(r => r.json()).then(usage => {
            if (usage.activeProfile === alias && usage.claude && usage.claude.ok && !usage.claude.loading) {
              claudeRow.classList.remove('switching');
              if (detailsDiv) detailsDiv.style.opacity = '1';
              refresh().catch(() => {});
            } else {
              attempts++;
              setTimeout(pollUsage, 200);
            }
          }).catch(() => {
            attempts++;
            setTimeout(pollUsage, 200);
          });
        }
        pollUsage();
      } catch (error) {
        if (aliasSpan) aliasSpan.textContent = originalText;
        if (detailsDiv) detailsDiv.style.opacity = '1';
        claudeRow.classList.remove('switching');
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
      renderAgentModal();
      const modal = document.getElementById('agent-modal');
      if (modal) modal.classList.add('open');
      toggleBodyScroll(true);
    }

    function closeAgentModal() {
      agentState.open = false;
      agentState.dialId = '';
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

    function bindProviderSwipeCard(cardId, rotateFn) {
      const card = document.getElementById(cardId);
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
        rotateFn(delta < 0 ? 1 : -1);
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
          openAgentModal(dialId);
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
      latestUsage = usage || {};
      const usageGrid = document.getElementById('usage-grid');
      const activeProfile = usage?.activeProfile || null;
      const rows = [
        providerUsageRow('codex', 'Codex', latestUsage.codex, activeProfile, []),
        providerUsageRow('claude', 'Claude', latestUsage.claude, activeProfile, latestProfiles),
        providerUsageRow('gemini', 'Gemini', latestUsage.gemini, activeProfile, []),
      ];
      const nextUsageHtml = rows.join('');
      if (usageGrid && usageGrid.innerHTML !== nextUsageHtml) {
        usageGrid.innerHTML = nextUsageHtml;
        bindUsageInteractions();
        bindProfileInteractions();
      }
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

    async function refresh() {
      const sessionsTask = fetch('/api/sessions', { cache: 'no-store' })
        .then(function (resp) { return resp.json(); })
        .then(function (payload) { renderSessions(payload || {}); })
        .catch(function () {});

      const usageTask = fetch('/api/usage', { cache: 'no-store' })
        .then(function (resp) { return resp.json(); })
        .then(function (usage) { renderUsageGrid(usage || {}); })
        .catch(function () {
          renderUsageGrid(latestUsage);
        });

      const profilesTask = fetch('/api/profiles', { cache: 'no-store' })
        .then(function (resp) { return resp.json(); })
        .then(function (payload) {
          if (payload && Array.isArray(payload.profiles)) {
            latestProfiles = payload.profiles;
          }
        })
        .catch(function () {});

      await Promise.allSettled([sessionsTask, usageTask, profilesTask]);
    }

    bindStaticModalInteractions();
    bindSessionInteractions();
    renderHotDials();
    refresh();
    setInterval(refresh, ${REFRESH_MS});
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

  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const usage = getUsageSnapshot();
    json(res, 200, usage);
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
      const launched = await launchHotDialAgent(dialId, provider);
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
      const profiles = Object.entries(catalog.profiles || {}).map(([alias, meta]) => ({
        alias,
        displayName: meta.displayName || alias,
        email: meta.email || null,
        createdAt: meta.createdAt || null,
      }));
      json(res, 200, { active: catalog.active, profiles });
    } catch (error) {
      json(res, 500, { error: error.message || 'profiles read failed' });
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
      // Shell out to atc-profile use <alias>
      const atcProfilePath = path.join(__dirname, 'scripts', 'atc-profile.mjs');
      const result = await runCommand('node', [atcProfilePath, 'use', alias], 30000);
      if (!result.ok) {
        json(res, 500, { error: result.stderr || 'Profile switch failed' });
        return;
      }
      // Invalidate usage cache to force refresh
      usageCache = { value: null, fetchedAt: 0, pending: null };
      refreshUsageSummaryInBackground().catch(() => {});
      json(res, 200, { ok: true, active: alias });
    } catch (error) {
      json(res, 500, { error: error.message || 'switch failed' });
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
  await Promise.all([loadState(), loadDashboardCss()]);
  await ingestTelemetry().catch(() => {});
  refreshUsageSummaryInBackground().catch(() => {});
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
