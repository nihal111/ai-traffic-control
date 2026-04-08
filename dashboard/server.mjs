#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
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
const TITLE_POLL_MS = Number(process.env.TITLE_POLL_MS || 300000);
const SLOT_RUN_RETENTION = Number(process.env.SLOT_RUN_RETENTION || 3);
const RECENT_WORKDIR_LIMIT = 5;
const TEMPLATE_NEW_BRAINSTORM = 'new_brainstorm';
const TEMPLATE_CONTINUE_WORK = 'continue_work';
const PERSONA_NONE = 'none';
const PROVIDERS = new Set(['codex', 'claude', 'gemini']);
const ENABLE_PROVIDER_AUTO_LAUNCH = process.env.ATC_AUTO_LAUNCH_PROVIDER !== '0';
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
    accent: '#f59e0b',
    promptFile: 'brainstormer.md',
  },
  {
    id: 'refactor',
    label: 'Refactor',
    description: 'Simplify code, reduce duplication, and improve structure safely.',
    accent: '#60a5fa',
    promptFile: 'refactor.md',
  },
  {
    id: 'tester',
    label: 'Tester',
    description: 'Focus on behavior, test quality, and meaningful coverage.',
    accent: '#34d399',
    promptFile: 'tester.md',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Inspect changes critically for bugs, regressions, and gaps.',
    accent: '#f472b6',
    promptFile: 'reviewer.md',
  },
  {
    id: 'slot_machine_bandit',
    label: 'Slot Machine Bandit',
    description: 'Hunt for the most promising next thread or re-entry point.',
    accent: '#a78bfa',
    promptFile: 'slot-machine-bandit.md',
  },
];
const PERSONA_BY_ID = new Map(PERSONA_CONFIGS.map((persona) => [persona.id, persona]));
const PERSONA_SELECTABLE = PERSONA_CONFIGS.filter((persona) => persona.id !== PERSONA_NONE);
const PERSONA_ALIASES = new Map([
  ['lucky_dip_explorer', 'slot_machine_bandit'],
  ['lucky-dip-explorer', 'slot_machine_bandit'],
]);

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

async function readPersonaPrompt(personaId) {
  const persona = personaConfig(personaId);
  if (!persona || persona.id === PERSONA_NONE || !persona.promptFile) return null;
  const promptPath = path.join(PERSONAS_DIR, persona.promptFile);
  const raw = await fs.readFile(promptPath, 'utf8');
  return String(raw || '').trimEnd();
}

function shellPromptSubstitution(promptText) {
  const encoded = Buffer.from(String(promptText || ''), 'utf8').toString('base64');
  return `$(node -e "process.stdout.write(Buffer.from(process.argv[1],'base64').toString('utf8'))" ${shSingle(encoded)})`;
}

function buildProviderLaunchCommand(provider, workdir, promptText) {
  const baseCommand = providerBootCommand(provider);
  const workdirPrefix = workdir ? `cd ${shSingle(workdir)} && ` : '';
  if (!promptText) return `${workdirPrefix}${baseCommand}`;
  return `${workdirPrefix}${baseCommand} "${shellPromptSubstitution(promptText)}"`;
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

  usageCache.pending = (async () => {
    const [codexRaw, claudeRaw, geminiRaw] = await Promise.all([
      fetchCodexbarUsage('codex', 'cli'),
      fetchCodexbarUsage('claude', 'web'),
      fetchCodexbarUsage('gemini', 'auto'),
    ]);

    return {
      fetchedAt: new Date().toISOString(),
      codex: decorateUsageWindows(codexRaw, ['5-hour', 'weekly']),
      claude: decorateUsageWindows(claudeRaw, ['5-hour', 'weekly']),
      gemini: decorateUsageWindows(geminiRaw, ['24h primary', '24h secondary']),
    };
  })();

  const value = await usageCache.pending;
  usageCache = { value, fetchedAt: Date.now(), pending: null };
  return value;
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

async function saveState(state) {
  await ensureDir(STATE_FILE);
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, STATE_FILE);
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
    titleFile: path.join(currentDir, 'title.txt'),
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
  const personaPrompt = await readPersonaPrompt(sessionState?.personaId);
  const command = buildProviderLaunchCommand(provider, sessionState?.workdir || DEFAULT_WORKDIR, personaPrompt);
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
    ['list-panes', '-t', sessionName, '-F', '#{window_name}\t#{pane_active}\t#{pane_current_path}\t#{session_activity}'],
    3000
  );
  if (!result.ok) return null;

  const rows = (result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [windowName, paneActive, paneCurrentPath, sessionActivity] = line.split('\t');
      return {
        windowName: windowName || '',
        paneActive: paneActive === '1',
        paneCurrentPath: paneCurrentPath || null,
        sessionActivity: Number(sessionActivity),
      };
    });
  if (rows.length === 0) return null;

  const preferred = rows.find((row) => row.windowName === TMUX_SLOT_WINDOW) || rows.find((row) => row.paneActive) || rows[0];
  const activityMs = Number.isFinite(preferred.sessionActivity) && preferred.sessionActivity > 0 ? preferred.sessionActivity * 1000 : null;
  return {
    cwd: preferred.paneCurrentPath || null,
    lastInteractionAt: activityMs ? new Date(activityMs).toISOString() : null,
  };
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
  await fs.writeFile(paths.titleFile, '', 'utf8');

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

function generateTitleFromEvents(events) {
  const recent = events.slice(-10);
  const lastPrompt = [...recent].reverse().find((e) => e.eventType === 'UserPromptSubmit' && e.payload?.prompt);
  if (lastPrompt?.payload?.prompt) return compactText(lastPrompt.payload.prompt, 72);

  const lastCommand = [...recent].reverse().find((e) => typeof e.command === 'string' && e.command.trim());
  if (lastCommand?.command) return `Shell: ${compactText(lastCommand.command, 64)}`;

  const provider = [...recent].reverse().find((e) => e.provider)?.provider;
  if (provider) return `${String(provider).toUpperCase()} session`;
  return '';
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

async function recomputeDerivedForSlot(slot, stateRecord) {
  if (!stateRecord?.runId) return;
  const runtime = slotRuntimePaths(slot.name);
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
  const tmuxPaneState = await readTmuxSlotPaneState(slot.name);
  const titlePath = runtime.titleFile;

  let title = '';
  try {
    title = (await fs.readFile(titlePath, 'utf8')).trim();
  } catch {
    title = '';
  }

  if (!title) {
    title = generateTitleFromEvents(events);
    await fs.writeFile(titlePath, `${title}\n`, 'utf8');
  }

  const eventLastTs = last.ts ? new Date(last.ts).getTime() : NaN;
  const tmuxLastTs = tmuxPaneState?.lastInteractionAt ? new Date(tmuxPaneState.lastInteractionAt).getTime() : NaN;
  const interactionAt =
    Number.isFinite(tmuxLastTs) && (!Number.isFinite(eventLastTs) || tmuxLastTs > eventLastTs) ? tmuxPaneState.lastInteractionAt : last.ts;

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
    agentType: lastProvider || 'none',
    title,
    contextWindowPct,
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

async function refreshTitles() {
  const [cfg, state] = await Promise.all([readSessionsConfig(), loadState()]);
  await Promise.all(
    cfg.map(async (slot) => {
      const st = state.sessions[slot.name];
      if (!st || st.status !== 'active' || !st.runId) return;
      const runtime = slotRuntimePaths(slot.name);
      const events = await readEvents(runtime.eventsFile, st.runId);
      if (events.length === 0) return;
      const title = generateTitleFromEvents(events);
      if (!title) return;
      await fs.writeFile(runtime.titleFile, `${title}\n`, 'utf8');
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
        taskTitle:
          st.status === 'active' && st.runId && derived && derived.runId === st.runId && typeof derived.title === 'string' && derived.title
            ? derived.title
            : st.taskTitle,
        agentType:
          st.status === 'active' && st.runId && derived && derived.runId === st.runId && typeof derived.agentType === 'string'
            ? derived.agentType
            : st.agentType,
        workdir: displayWorkdir,
        activeSince: displayActiveSince || null,
        telemetry: st.status === 'active' && st.runId && derived && derived.runId === st.runId ? derived : null,
        active,
        backendActive,
        startedAgo: displayActiveSince ? durationSince(displayActiveSince) : 'n/a',
        lastInteractionAgo: displayLastInteraction ? ago(displayLastInteraction) : 'n/a',
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
  const requestedWorkdir = typeof options.workdir === 'string' ? options.workdir : '';
  const effectiveWorkdirInput = requestedWorkdir.trim() || (templateProvided ? HOME_DIRECTORY : (st.workdir || DEFAULT_WORKDIR));
  const workdir = await resolveWorkdirForSpawn(templateId, effectiveWorkdirInput);

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
  <style>
    :root {
      --bg0: #0b1020;
      --bg1: #17223b;
      --text: #e6ecff;
      --muted: #9fb0d4;
      --line: #2c3c63;
      --green: #00c48c;
      --amber: #ffb020;
      --red: #ff4d6d;
      --cyan: #40c9ff;
      --purple: #8c7cff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Avenir", "Trebuchet MS", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(1200px 600px at 0% -20%, #1f5f9d4d 0%, transparent 55%),
        radial-gradient(1000px 600px at 100% 0%, #0b7a7044 0%, transparent 50%),
        linear-gradient(180deg, var(--bg0) 0%, var(--bg1) 100%);
      min-height: 100vh;
      padding: 16px;
    }
    body.modal-open {
      overflow: hidden;
      touch-action: none;
      -webkit-overflow-scrolling: none;
      overscroll-behavior: none;
    }
    .shell { max-width: 980px; margin: 0 auto; }
    .title-wrap {
      text-align: center;
      margin-top: 4px;
      margin-bottom: 10px;
      padding: 10px 14px;
      border: 1px solid #2c3c62;
      border-radius: 16px;
      background: linear-gradient(180deg, #172543cc, #10192fcc);
      box-shadow: 0 10px 26px #0000002a;
    }
    .title {
      margin: 0;
      font-size: 30px;
      letter-spacing: 0.3px;
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .title .decor { font-size: 24px; }
    .title .accent { color: #79c3ff; }
    .panel {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: #10182dbe;
      backdrop-filter: blur(8px);
      padding: 14px;
      margin-top: 14px;
      box-shadow: 0 8px 28px #0000002e;
      contain: layout;
    }
    .usage-stack { display: grid; gap: 10px; }
    .usage-row {
      border: 1px solid #2b3d64;
      border-radius: 14px;
      background: linear-gradient(150deg, #18274a 0%, #101a33 100%);
      padding: 10px 12px;
      position: relative;
    }
    .usage-toggle {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      border: 1px solid #355086;
      background: #132247;
      color: #dbe8ff;
      cursor: pointer;
      display: grid;
      place-items: center;
      transition: transform 120ms ease;
    }
    .usage-row.expanded .usage-toggle { transform: rotate(180deg); }
    .usage-toggle svg {
      width: 14px;
      height: 14px;
      display: block;
      stroke: currentColor;
      stroke-width: 2.2;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .provider {
      display: grid;
      grid-template-columns: 72px 1fr;
      align-items: stretch;
      gap: 10px;
      min-width: 0;
      padding-right: 34px;
    }
    .provider-logo {
      width: 72px;
      height: 72px;
      border-radius: 10px;
      border: 1px solid #d7e4ff;
      background: #ffffff;
      object-fit: contain;
      padding: 11px;
    }
    .provider-name-wrap { min-width: 0; }
    .provider-name {
      font-size: 16px;
      font-weight: 700;
      line-height: 1.1;
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
    }
    .provider-plan-inline {
      color: #afc3ec;
      font-size: 11px;
      font-weight: 600;
    }
    .provider-plan-block {
      display: none;
      color: #afc3ec;
      font-size: 12px;
      margin-top: 3px;
    }
    .provider-mini {
      margin-top: 5px;
      display: grid;
      gap: 4px;
    }
    .mini {
      display: grid;
      grid-template-columns: 78px 42px minmax(0, 1.45fr) minmax(112px, 0.85fr);
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .mini-label {
      color: #acc2ec;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.3px;
      white-space: nowrap;
    }
    .mini-pct {
      text-align: right;
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
    }
    .mini-bar {
      width: 100%;
      height: 6px;
      border-radius: 999px;
      background: #0e1730;
      border: 1px solid #2e4169;
      overflow: hidden;
    }
    .mini-bar-fill {
      height: 100%;
      width: 0%;
      transition: width 180ms ease-out;
      background: linear-gradient(90deg, #1bb172 0%, #f0b526 72%, #d7424d 100%);
    }
    .mini-reset {
      color: #ffffff;
      font-size: 11px;
      white-space: nowrap;
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .usage-details {
      margin-top: 8px;
      display: none;
    }
    .usage-row.expanded .usage-details { display: block; }
    .usage-row.expanded .provider {
      align-items: start;
      grid-template-columns: 72px 1fr;
    }
    .usage-row.expanded .provider-name {
      display: block;
      font-size: 21px;
      line-height: 1.05;
      margin-top: 1px;
    }
    .usage-row.expanded .provider-plan-inline { display: none; }
    .usage-row.expanded .provider-plan-block { display: block; }
    .usage-row.expanded .provider-mini { display: none; }
    .windows {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .window {
      border: 1px solid #30456f;
      border-radius: 12px;
      padding: 8px 10px;
      background: linear-gradient(160deg, #162647 0%, #101b36 100%);
    }
    .window-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 5px;
    }
    .window-label {
      color: #b6c6e7;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .window-value {
      font-size: 19px;
      font-weight: 800;
      line-height: 1;
    }
    .window-reset {
      color: #c9d8f8;
      font-size: 11px;
      line-height: 1.2;
    }
    .bar {
      margin-top: 6px;
      width: 100%;
      height: 7px;
      border-radius: 999px;
      background: #0e1730;
      border: 1px solid #2e4169;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      width: 0%;
      transition: width 180ms ease-out;
      background: linear-gradient(90deg, #1bb172 0%, #f0b526 72%, #d7424d 100%);
    }
    .window.missing {
      display: grid;
      place-content: center;
      text-align: center;
      color: #9eb2db;
      font-size: 12px;
      min-height: 76px;
    }
    .usage-row.error {
      border-color: #7c2d43;
      background: linear-gradient(150deg, #3c1928 0%, #2a1420 100%);
    }
    .usage-error {
      color: #ffcfda;
      font-size: 12px;
      line-height: 1.2;
    }

    .sessions { display: grid; gap: 10px; }
    .session {
      border: 1px solid #2d3e66;
      border-radius: 14px;
      background: linear-gradient(130deg, #162449 0%, #111831 60%, #111831 100%);
      position: relative;
      overflow: hidden;
      transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
      min-height: 160px;
    }
    .session::before {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, #0000 0%, #4cc9f024 50%, #0000 100%);
      transform: translateX(-100%);
      transition: transform 500ms ease;
      pointer-events: none;
    }
    .session:active { transform: scale(0.99); }
    .session.tap:hover { border-color: #4bc6ff; box-shadow: 0 0 0 1px #4bc6ff22 inset; cursor: pointer; }
    .session.tap:hover::before { transform: translateX(100%); }
    .session.spawning { border-color: #5a70b3; box-shadow: 0 0 0 1px #5a70b333 inset; }
    .session.spawning::before {
      animation: atc-shimmer 900ms linear infinite;
      transform: translateX(-100%);
    }
    @keyframes atc-shimmer {
      from { transform: translateX(-100%); }
      to { transform: translateX(100%); }
    }
    .session-inner { padding: 14px 52px 14px 14px; }
    .head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    .name { font-size: 17px; font-weight: 700; }
    .head-badges {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      max-width: 62%;
    }
    .badge {
      font-size: 11px;
      line-height: 1;
      padding: 6px 8px;
      border-radius: 999px;
      border: 1px solid #345;
      color: #dbe8ff;
      background: #1b294c;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .badge.active { border-color: #0f8e68; background: #0a3f31; color: #8ef6d3; }
    .badge.starting { border-color: #4a4d78; background: #20274a; color: #d5ddff; }
    .badge.idle { border-color: #72570f; background: #3f300c; color: #ffd98a; }
    .persona-badge {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      line-height: 1;
      padding: 6px 8px;
      border-radius: 999px;
      border: 1px solid var(--persona-accent, #5b73b4);
      color: var(--persona-accent, #cfe0ff);
      background: #151f38;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      white-space: nowrap;
    }

    .line { color: #d8e2ff; font-size: 13px; margin: 3px 0; }
    .line.muted { color: var(--muted); }
    .line strong { color: #f3f7ff; }

    .kill {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 34px;
      height: 34px;
      border-radius: 10px;
      border: 1px solid #6a2940;
      background: linear-gradient(180deg, #552036, #3d1526);
      color: #ffd5e0;
      font-size: 20px;
      line-height: 1;
      display: grid;
      place-items: center;
      cursor: pointer;
    }
    .kill[disabled] { opacity: 0.35; cursor: not-allowed; }

    .action-hint {
      margin-top: 10px;
      font-size: 12px;
      color: #ccdafb;
      border-top: 1px dashed #324365;
      padding-top: 8px;
    }
    .color-idle { color: var(--amber); }
    .color-active { color: var(--green); }
    .color-starting { color: #cdd8ff; }
    .error { color: var(--red); }

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: #081126b8;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
      z-index: 40;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      width: min(620px, 100%);
      max-height: 88vh;
      overflow: auto;
      border: 1px solid #365089;
      border-radius: 16px;
      background: linear-gradient(180deg, #142449, #0e1831);
      box-shadow: 0 18px 44px #00000052;
      padding: 14px;
    }
    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      gap: 10px;
    }
    .modal-title {
      font-size: 17px;
      font-weight: 700;
    }
    .modal-close {
      border: 1px solid #4967a8;
      border-radius: 9px;
      background: #18294f;
      color: #d8e5ff;
      width: 34px;
      height: 34px;
      font-size: 18px;
      cursor: pointer;
    }
    .intent-block { margin-top: 12px; }
    .intent-label {
      color: #cad9fb;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.35px;
      margin-bottom: 7px;
    }
    .provider-carousel {
      display: grid;
      grid-template-columns: 34px 1fr 34px;
      gap: 8px;
      align-items: center;
    }
    .carousel-nav {
      border: 1px solid #4d69a8;
      border-radius: 9px;
      background: #172850;
      color: #d9e6ff;
      height: 42px;
      cursor: pointer;
      font-size: 16px;
    }
    .provider-select-card {
      border: 1px solid #3c548f;
      border-radius: 12px;
      background: linear-gradient(150deg, #1b2a4f 0%, #111b36 100%);
      padding: 10px;
      min-height: 108px;
      touch-action: pan-y;
      contain: layout;
    }
    .provider-select-head {
      display: grid;
      grid-template-columns: 46px 1fr;
      gap: 9px;
      align-items: center;
    }
    .provider-select-logo {
      width: 46px;
      height: 46px;
      border-radius: 8px;
      background: #fff;
      object-fit: contain;
      border: 1px solid #d7e4ff;
      padding: 6px;
    }
    .provider-select-name {
      font-size: 16px;
      font-weight: 700;
      line-height: 1.1;
    }
    .provider-select-plan {
      color: #aec2ec;
      font-size: 11px;
      margin-top: 3px;
    }
    .provider-select-windows {
      margin-top: 8px;
      display: grid;
      gap: 4px;
    }
    .template-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .template-btn {
      border: 1px solid #3a4f82;
      border-radius: 11px;
      background: #111b35;
      color: #dce7ff;
      text-align: left;
      padding: 10px;
      cursor: pointer;
      min-height: 76px;
    }
    .template-btn.active {
      border-color: #5f87e0;
      box-shadow: 0 0 0 1px #5f87e044 inset;
      background: #15254a;
    }
    .template-title {
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .template-subtitle {
      color: #adc2ea;
      font-size: 12px;
      line-height: 1.25;
    }
    .persona-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .persona-btn {
      border: 1px solid #3a4f82;
      border-radius: 11px;
      background: #111b35;
      color: #dce7ff;
      text-align: left;
      padding: 10px;
      cursor: pointer;
      min-height: 86px;
    }
    .persona-btn.active {
      border-color: var(--persona-accent, #5f87e0);
      box-shadow: 0 0 0 1px #ffffff18 inset;
      background: #15254a;
    }
    .persona-name {
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .persona-desc {
      color: #adc2ea;
      font-size: 12px;
      line-height: 1.25;
    }
    .persona-note {
      margin-top: 8px;
      color: #91a6cf;
      font-size: 11px;
      line-height: 1.35;
    }
    .workdir-row {
      border: 1px solid #344975;
      border-radius: 10px;
      background: #101b33;
      padding: 9px;
      display: grid;
      gap: 8px;
    }
    .recent-workdirs {
      margin-top: 10px;
      border: 1px solid #2f456f;
      border-radius: 10px;
      background: #0f1a30;
      padding: 8px;
    }
    .recent-workdirs-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #95acd9;
      margin-bottom: 8px;
      font-weight: 700;
    }
    .recent-workdirs-list {
      display: grid;
      gap: 6px;
    }
    .recent-workdir-btn {
      width: 100%;
      text-align: left;
      border: 1px solid #30486f;
      border-radius: 8px;
      background: #142340;
      color: #d8e5ff;
      padding: 7px 9px;
      cursor: pointer;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.35;
      word-break: break-all;
    }
    .recent-workdir-btn.active {
      border-color: #6491eb;
      background: #1a2f57;
      box-shadow: 0 0 0 1px #6491eb33 inset;
    }
    .recent-workdirs-empty {
      color: #8ea5d2;
      font-size: 12px;
      margin: 0;
    }
    .workdir-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: #d6e3ff;
      word-break: break-all;
    }
    .choose-btn {
      justify-self: start;
      border: 1px solid #4465a8;
      border-radius: 8px;
      background: #183059;
      color: #dce9ff;
      padding: 7px 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    .modal-actions {
      margin-top: 14px;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .btn-secondary,
    .btn-primary {
      border-radius: 9px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .btn-secondary {
      border: 1px solid #4a6196;
      background: #162646;
      color: #d9e5ff;
    }
    .btn-primary {
      border: 1px solid #5981da;
      background: #315ebf;
      color: #f5f9ff;
    }
    .btn-danger {
      border: 1px solid #a63e4d;
      background: #7f2432;
      color: #ffe4e9;
      border-radius: 9px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .confirm-text {
      margin: 6px 0 2px;
      color: #d8e4ff;
      font-size: 14px;
      line-height: 1.35;
    }
    .picker-list {
      display: grid;
      gap: 6px;
      margin-top: 10px;
      max-height: 320px;
      overflow: auto;
    }
    .picker-item {
      border: 1px solid #30466f;
      border-radius: 9px;
      background: #101a33;
      color: #d8e5ff;
      text-align: left;
      padding: 9px;
      cursor: pointer;
      font-size: 13px;
    }
    .picker-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 10px;
    }

    @media (max-width: 640px) {
      body { padding: 12px; }
      .title { font-size: 22px; }
      .title .decor { font-size: 18px; }
      .provider { grid-template-columns: 46px 1fr; }
      .provider-logo { min-height: 58px; padding: 8px; }
      .usage-row.expanded .provider { grid-template-columns: 46px 1fr; }
      .mini { grid-template-columns: 62px 34px minmax(0, 1.35fr) minmax(84px, 0.9fr); gap: 5px; }
      .mini-label, .mini-pct, .mini-reset { font-size: 10px; }
      .windows { grid-template-columns: 1fr; }
      .session-inner { padding-right: 46px; }
      .name { font-size: 16px; }
      .template-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="title-wrap">
      <h1 class="title"><span class="decor">🗼</span><span class="accent">AI Traffic Control</span><span class="decor">💻</span></h1>
    </section>

    <section class="panel">
      <div class="usage-stack" id="usage-grid"></div>
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
      <div class="intent-block">
        <div class="intent-label">Provider</div>
        <div class="provider-carousel">
          <button type="button" class="carousel-nav" id="provider-prev" aria-label="Previous provider">&#8592;</button>
          <div id="provider-select"></div>
          <button type="button" class="carousel-nav" id="provider-next" aria-label="Next provider">&#8594;</button>
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
    const HOME_DIRECTORY = ${JSON.stringify(HOME_DIRECTORY)};
    const PERSONA_NONE = ${JSON.stringify(PERSONA_NONE)};
    const PERSONA_CONFIGS = ${JSON.stringify(PERSONA_CONFIGS)};
    const PERSONA_MAP = new Map(PERSONA_CONFIGS.map((persona) => [persona.id, persona]));
    const PROVIDER_ORDER = [
      { key: 'codex', title: 'Codex' },
      { key: 'claude', title: 'Claude' },
      { key: 'gemini', title: 'Gemini' },
    ];
    let latestUsage = {};
    const intentState = {
      open: false,
      name: '',
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

    function toggleBodyScroll(locked) {
      document.body.classList.toggle('modal-open', !!locked);
    }

    function esc(v) {
      return String(v)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
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

    function providerUsageRow(providerKey, title, payload) {
      const logo = PROVIDER_LOGOS[providerKey] || '';
      const isExpanded = usageExpanded.has(providerKey);
      if (!payload || !payload.ok) {
        return '<article class="usage-row error">' +
          '<button type="button" class="usage-toggle" data-toggle-provider="' + esc(providerKey) + '" aria-expanded="false" aria-label="Toggle ' + esc(title) + ' details">' +
            '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>' +
          '</button>' +
          '<div class="provider">' +
            '<img class="provider-logo" src="' + esc(logo) + '" alt="' + esc(title) + ' logo" loading="lazy" width="72" height="72" />' +
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
          '<img class="provider-logo" src="' + esc(logo) + '" alt="' + esc(title) + ' logo" loading="lazy" width="72" height="72" />' +
          '<div class="provider-name-wrap">' +
            '<div class="provider-name">' + esc(title) + ' <span class="provider-plan-inline">(' + esc(plan) + ')</span></div>' +
            '<div class="provider-plan-block">' + esc(plan) + '</div>' +
            '<div class="provider-mini">' +
              miniWindow(payload.primary) +
              miniWindow(payload.secondary) +
            '</div>' +
          '</div>' +
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

    function renderPersonaSelector() {
      return '<div class="persona-grid">' +
        PERSONA_CONFIGS.map((persona) => {
          const active = normalizePersonaId(intentState.personaId) === persona.id;
          const classes = ['persona-btn'];
          if (active) classes.push('active');
          return '<button type="button" class="' + classes.join(' ') + '" data-persona-id="' + esc(persona.id) + '" aria-pressed="' + (active ? 'true' : 'false') + '" style="--persona-accent:' + esc(persona.accent) + '">' +
            '<div class="persona-name">' + esc(persona.label) + '</div>' +
            '<div class="persona-desc">' + esc(persona.description) + '</div>' +
          '</button>';
        }).join('') +
      '</div>' +
      '<div class="persona-note">Selected at start only. Changing persona later means killing and respawning the session.</div>';
    }

    function personaBadge(personaId) {
      const persona = personaForId(personaId);
      if (!persona || persona.id === PERSONA_NONE) return '';
      return '<span class="persona-badge" data-persona-badge="1" style="--persona-accent:' + esc(persona.accent) + '">' + esc(persona.label) + '</span>';
    }

    function hostForPort(port) {
      return window.location.protocol + '//' + window.location.hostname + ':' + port;
    }

    function connectUrlForPort(port) {
      const base = hostForPort(port);
      const sep = base.includes('?') ? '&' : '?';
      return base + sep + 'atc_connect=' + Date.now();
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

    function openIntentModal(name) {
      intentState.open = true;
      intentState.name = name;
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
      const modal = document.getElementById('intent-modal');
      if (modal) modal.classList.remove('open');
      toggleBodyScroll(false);
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
      if (!intentState.open && !killState.open) toggleBodyScroll(false);
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
      toggleBodyScroll(false);
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

    function providerSelectionCard(provider) {
      const logo = PROVIDER_LOGOS[provider.key] || '';
      const usage = latestUsage ? latestUsage[provider.key] : null;
      if (!usage || !usage.ok) {
        return '<div class="provider-select-card" id="provider-select-card">' +
          '<div class="provider-select-head">' +
            '<img class="provider-select-logo" src="' + esc(logo) + '" alt="' + esc(provider.title) + ' logo" loading="lazy" width="46" height="46" />' +
            '<div><div class="provider-select-name">' + esc(provider.title) + '</div><div class="provider-select-plan">Usage unavailable</div></div>' +
          '</div>' +
          '<div class="provider-select-windows">' + miniWindow(null) + miniWindow(null) + '</div>' +
        '</div>';
      }
      const plan = compactPlan(usage.plan || 'connected');
      return '<div class="provider-select-card" id="provider-select-card">' +
        '<div class="provider-select-head">' +
          '<img class="provider-select-logo" src="' + esc(logo) + '" alt="' + esc(provider.title) + ' logo" loading="lazy" width="46" height="46" />' +
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

      const selectedProvider = PROVIDER_ORDER[activeProviderIndex()];
      const providerHost = document.getElementById('provider-select');
      if (providerHost) providerHost.innerHTML = providerSelectionCard(selectedProvider);

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
      bindProviderSwipe();
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

    function bindProviderSwipe() {
      const card = document.getElementById('provider-select-card');
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
        rotateProvider(delta < 0 ? 1 : -1);
      });
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
          intentState.personaId = normalizePersonaId(btn.getAttribute('data-persona-id'));
          renderIntentModal();
        });
      }
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
          const payload = {
            provider: intentState.providerKey,
            templateId: intentState.templateId,
            personaId: intentState.personaId,
            workdir: intentState.templateId === 'continue_work' ? intentState.workdir : HOME_DIRECTORY,
          };
          closeIntentModal();
          await spawnSession(intentState.name, payload);
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
          await killSession(target);
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

    async function spawnSession(name, options) {
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
        setTimeout(refresh, 350);
        setTimeout(refresh, 900);
        setTimeout(refresh, 1600);
        setTimeout(refresh, 2400);
      }
    }

    async function killSession(name) {
      if (refreshing.has(name)) return;
      refreshing.add(name);
      try {
        await apiPost('/api/sessions/kill', { name: name });
      } catch (err) {
        alert('Kill failed for ' + name + ': ' + err.message);
      } finally {
        refreshing.delete(name);
        await refresh();
      }
    }

    function sessionCard(s) {
      const isActive = s.status === 'active' && s.backendActive;
      const isSpawning = spawning.has(s.name);
      const hasAgent = !!(s.telemetry && s.telemetry.agentType && s.telemetry.agentType !== 'none');
      const personaId = normalizePersonaId(s.personaId);
      const actionText = isSpawning ? 'Starting terminal…' : (isActive ? 'Tap to connect' : 'Tap to start');
      const actionClass = isSpawning ? 'color-starting' : (isActive ? 'color-active' : 'color-idle');
      const badgeClass = isSpawning ? 'starting' : (isActive ? 'active' : 'idle');
      const badgeText = isSpawning ? 'starting' : (isActive ? 'active' : 'idle');

      return '<article class="session tap ' + (isSpawning ? 'spawning' : '') + '" data-name="' + esc(s.name) + '" data-persona-id="' + esc(personaId) + '" data-active="' + (isActive ? '1' : '0') + '" data-spawning="' + (isSpawning ? '1' : '0') + '">' +
        '<button type="button" class="kill" ' + (isActive ? '' : 'disabled') + ' data-kill="1" data-name="' + esc(s.name) + '" aria-label="Kill ' + esc(s.name) + '">&times;</button>' +
        '<div class="session-inner">' +
          '<div class="head">' +
            '<div class="name">' + esc(s.name) + '</div>' +
            '<div class="head-badges">' +
              '<span class="badge ' + esc(badgeClass) + '">' + esc(badgeText) + '</span>' +
              personaBadge(personaId) +
            '</div>' +
          '</div>' +
          '<div class="line"><strong>Task:</strong> ' + esc(s.taskTitle || 'Not set') + '</div>' +
          '<div class="line"><strong>Workdir:</strong> ' + esc(s.workdir || 'Not set') + '</div>' +
          (hasAgent
            ? '<div class="line muted">Agent: ' + esc(s.agentType || 'none') + ' | Turns: ' + esc((s.telemetry && s.telemetry.turnCount) ? s.telemetry.turnCount : 0) + '</div>'
            : '') +
          (hasAgent
            ? '<div class="line muted">Context window: ' + esc((s.telemetry && Number.isFinite(Number(s.telemetry.contextWindowPct))) ? (Math.round(Number(s.telemetry.contextWindowPct)) + '%') : 'N/A') + '</div>'
            : '') +
          '<div class="line muted">Active for: ' + esc(s.startedAgo || 'n/a') + ' | Last interaction: ' + esc(s.lastInteractionAgo || 'n/a') + '</div>' +
          '<div class="line muted">Shell: ' + esc(compact((s.telemetry && s.telemetry.lastCommand) ? s.telemetry.lastCommand : 'no command yet', 60)) + '</div>' +
          (s.error ? '<div class="line error">' + esc(s.error) + '</div>' : '') +
          '<div class="action-hint ' + actionClass + '">' + esc(actionText) + '</div>' +
        '</div>' +
      '</article>';
    }

    function bindSessionInteractions(sessions) {
      const byName = new Map(sessions.map((s) => [s.name, s]));
      const cards = document.querySelectorAll('.session.tap');
      for (const card of cards) {
        card.addEventListener('click', async function (ev) {
          const killTarget = ev.target.closest('[data-kill="1"]');
          if (killTarget) return;
          const name = card.getAttribute('data-name');
          const item = byName.get(name);
          if (!item) return;

          const active = item.status === 'active' && item.backendActive;
          const isSpawning = spawning.has(item.name);
          if (isSpawning) return;
          if (active) {
            await prewarmPublicEndpoint(item.publicPort);
            window.open(connectUrlForPort(item.publicPort), '_blank', 'noopener,noreferrer');
            return;
          }
          openIntentModal(item.name);
        });
      }

      const kills = document.querySelectorAll('[data-kill="1"]');
      for (const btn of kills) {
        btn.addEventListener('click', async function (ev) {
          ev.stopPropagation();
          if (btn.hasAttribute('disabled')) return;
          const name = btn.getAttribute('data-name');
          if (!name) return;
          openKillModal(name);
        });
      }
    }

    async function refresh() {
      const [usageResp, sessionsResp] = await Promise.all([
        fetch('/api/usage', { cache: 'no-store' }),
        fetch('/api/sessions', { cache: 'no-store' }),
      ]);

      const usage = await usageResp.json();
      latestUsage = usage || {};
      const sessionsPayload = await sessionsResp.json();
      const sessions = sessionsPayload.sessions || [];
      const latestRecent = Array.isArray(sessionsPayload.recentWorkdirs) ? sessionsPayload.recentWorkdirs : [];
      recentWorkdirs.splice(0, recentWorkdirs.length, ...latestRecent);

      const usageGrid = document.getElementById('usage-grid');
      const rows = [
        providerUsageRow('codex', 'Codex', usage.codex),
        providerUsageRow('claude', 'Claude', usage.claude),
        providerUsageRow('gemini', 'Gemini', usage.gemini),
      ];
      const nextUsageHtml = rows.join('');
      if (usageGrid && usageGrid.innerHTML !== nextUsageHtml) {
        usageGrid.innerHTML = nextUsageHtml;
        bindUsageInteractions();
      }

      const sessionsEl = document.getElementById('sessions');
      const nextSessionsHtml = sessions.map(sessionCard).join('') || '<div class="line muted">No sessions configured.</div>';
      if (sessionsEl && sessionsEl.innerHTML !== nextSessionsHtml) {
        sessionsEl.innerHTML = nextSessionsHtml;
        bindSessionInteractions(sessions);
      }
    }

    bindStaticModalInteractions();
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
      const data = await fs.readFile(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-store, max-age=0',
        'Content-Length': data.length,
      });
      res.end(data);
    } catch {
      json(res, 404, { error: 'asset not found' });
    }
    return;
  }

  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const usage = await getUsageSummary();
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

  json(res, 404, { error: 'not found' });
});

async function startDashboardServer() {
  await loadState();
  await ingestTelemetry().catch(() => {});
  await refreshTitles().catch(() => {});
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`dashboard listening on http://0.0.0.0:${PORT}`);
  });

  setInterval(() => {
    ingestTelemetry().catch(() => {});
  }, TELEMETRY_INGEST_MS);

  setInterval(() => {
    refreshTitles().catch(() => {});
  }, TITLE_POLL_MS);
}

if (process.env.DASHBOARD_TEST_IMPORT !== '1') {
  await startDashboardServer();
}

export {
  buildProviderLaunchCommand,
  fetchCodexbarUsage,
  normalizePersonaId,
  personaConfig,
  PERSONA_CONFIGS,
};
