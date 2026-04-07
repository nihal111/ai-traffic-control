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
const TTYD_BIN = process.env.TTYD_BIN || '/opt/homebrew/bin/ttyd';
const SHELL_BIN = process.env.SHELL_BIN || '/bin/zsh';
const DEFAULT_WORKDIR = process.env.DEFAULT_SESSION_WORKDIR || '/Users/nihal/Code/MobileDev';
const SHELL_HOOK_WRITER = process.env.SHELL_HOOK_WRITER || path.join(__dirname, 'scripts', 'shell-hook-writer.mjs');
const REFRESH_MS = 8000;
const USAGE_TTL_MS = 10000;
const TELEMETRY_INGEST_MS = Number(process.env.TELEMETRY_INGEST_MS || 20000);
const TITLE_POLL_MS = Number(process.env.TITLE_POLL_MS || 300000);
const SLOT_RUN_RETENTION = Number(process.env.SLOT_RUN_RETENTION || 3);

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

async function getCodexUsage() {
  const now = Date.now();
  if (usageCache.value && now - usageCache.fetchedAt < USAGE_TTL_MS) return usageCache.value;
  if (usageCache.pending) return usageCache.pending;

  usageCache.pending = (async () => {
    const raw = await runCommand('codexbar', ['usage', '--provider', 'codex', '--source', 'cli', '--format', 'json']);
    if (!raw.ok) return { provider: 'Codex', ok: false, error: raw.stderr || 'codexbar usage failed' };

    try {
      const parsed = JSON.parse(raw.stdout);
      const root = Array.isArray(parsed) ? parsed[0] : parsed;
      const usage = root?.usage || null;
      const openaiDashboard = root?.openaiDashboard || null;
      const primary = usage?.primary || openaiDashboard?.primaryLimit || null;
      const secondary = usage?.secondary || openaiDashboard?.secondaryLimit || null;
      const accountEmail = usage?.accountEmail || openaiDashboard?.signedInEmail || 'unknown';
      const plan = usage?.loginMethod || openaiDashboard?.accountPlan || root?.source || 'unknown';

      return {
        provider: 'Codex',
        ok: true,
        accountEmail,
        plan,
        fiveHour: primary
          ? {
              usedPercent: Number(primary.usedPercent ?? 0),
              windowMinutes: Number(primary.windowMinutes ?? 300),
              resetsAt: primary.resetsAt || null,
            }
          : null,
        weekly: secondary
          ? {
              usedPercent: Number(secondary.usedPercent ?? 0),
              windowMinutes: Number(secondary.windowMinutes ?? 10080),
              resetsAt: secondary.resetsAt || null,
            }
          : null,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      return { provider: 'Codex', ok: false, error: `failed to parse codexbar json: ${error.message}` };
    }
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
  let current = { version: 1, updatedAt: new Date().toISOString(), sessions: {} };
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
  for (const slot of cfg) {
    if (!merged.sessions[slot.name]) merged.sessions[slot.name] = defaultSessionState(slot);
    merged.sessions[slot.name].name = slot.name;
    if (!merged.sessions[slot.name].workdir) merged.sessions[slot.name].workdir = DEFAULT_WORKDIR;
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

function pidFileForBackend(backendPort) {
  return path.join(RUN_DIR, `ttyd-${backendPort}.pid`);
}

function logFileForBackend(backendPort) {
  return path.join(RUN_DIR, `ttyd-${backendPort}.log`);
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

function shSingle(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function buildAtcZshrc(env) {
  return [
    '#!/usr/bin/env zsh',
    '# Generated by AI Traffic Control for shell-level telemetry hooks.',
    'if [[ -f "$HOME/.zshrc" ]]; then',
    '  source "$HOME/.zshrc"',
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

async function ensureSlotRuntime(slotName, runId, workdir) {
  const paths = slotRuntimePaths(slotName);
  await fs.mkdir(paths.currentDir, { recursive: true });
  await fs.mkdir(paths.zdotdir, { recursive: true });

  const now = new Date().toISOString();
  const meta = {
    slot: slotName,
    runId,
    activeSince: now,
    lastInteractionAt: now,
    cwd: workdir || DEFAULT_WORKDIR,
    eventCount: 0,
    shellStartedAt: now,
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
  return 'Interactive shell session';
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

  const derived = {
    slot: slot.name,
    runId: stateRecord.runId,
    provider: lastProvider,
    activeSince: first.ts || stateRecord.spawnedAt || null,
    lastInteractionAt: last.ts || stateRecord.lastInteractionAt || null,
    cwd: lastWithCwd?.cwd || stateRecord.workdir || null,
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

async function spawnSessionBackend(slot, sessionState, runtimeEnv) {
  if (!fsSync.existsSync(TTYD_BIN)) throw new Error(`ttyd not found at ${TTYD_BIN}`);
  await fs.mkdir(RUN_DIR, { recursive: true });

  const backendTaken = await checkPortOpen(slot.backendPort);
  if (backendTaken) throw new Error(`backend port ${slot.backendPort} is already in use`);

  const out = fsSync.openSync(logFileForBackend(slot.backendPort), 'a');
  const child = spawn(
    TTYD_BIN,
    ['-W', '-i', '127.0.0.1', '-p', String(slot.backendPort), '-t', 'scrollback=100000', '-t', 'disableResizeOverlay=true', '--', SHELL_BIN, '-il'],
    {
      cwd: sessionState.workdir || DEFAULT_WORKDIR,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ...runtimeEnv, DASH_SLOT_NAME: slot.name, ZDOTDIR: runtimeEnv.ATC_ZDOTDIR },
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
}

async function getMergedSessions() {
  const [cfg, state] = await Promise.all([readSessionsConfig(), loadState()]);
  const merged = await Promise.all(
    cfg.map(async (slot) => {
      const st = state.sessions[slot.name] || defaultSessionState(slot);
      const runtime = slotRuntimePaths(slot.name);
      const derived = await readJsonSafe(runtime.derivedFile, null);
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

      const displayWorkdir =
        st.status === 'active' && st.runId && derived && derived.runId === st.runId && typeof derived.cwd === 'string' && derived.cwd
          ? derived.cwd
          : st.workdir;
      const displayLastInteraction =
        st.status === 'active' && st.runId && derived && derived.runId === st.runId && typeof derived.lastInteractionAt === 'string'
          ? derived.lastInteractionAt
          : st.lastInteractionAt;
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

async function spawnSlotByName(name) {
  const [cfg, state] = await Promise.all([readSessionsConfig(), loadState()]);
  const slot = cfg.find((s) => s.name === name);
  if (!slot) throw new Error('session not found');

  const st = state.sessions[slot.name] || defaultSessionState(slot);
  const alreadyUp = await checkPortOpen(slot.backendPort);
  if (alreadyUp) {
    st.status = 'active';
    if (!st.spawnedAt) st.spawnedAt = new Date().toISOString();
    state.sessions[slot.name] = st;
    await saveState(state);
    return;
  }

  const runId = makeRunId();
  await rotateSlotCurrent(slot.name, st.runId);
  const { hookEnv } = await ensureSlotRuntime(slot.name, runId, st.workdir);
  const pid = await spawnSessionBackend(slot, st, {
    ...hookEnv,
    ATC_ZDOTDIR: slotRuntimePaths(slot.name).zdotdir,
  });
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
        radial-gradient(1200px 600px at 0% -20%, #22346a55 0%, transparent 55%),
        radial-gradient(1000px 600px at 100% 0%, #4a2d7f44 0%, transparent 50%),
        linear-gradient(180deg, var(--bg0) 0%, var(--bg1) 100%);
      min-height: 100vh;
      padding: 16px;
    }
    .shell { max-width: 900px; margin: 0 auto; }
    h1 { margin: 0; font-size: 26px; letter-spacing: 0.2px; }
    .sub { margin-top: 6px; color: var(--muted); font-size: 14px; }
    .panel {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: #10182dbe;
      backdrop-filter: blur(8px);
      padding: 14px;
      margin-top: 14px;
      box-shadow: 0 8px 28px #0000002e;
    }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .stat {
      border: 1px solid #2e3f67;
      border-radius: 12px;
      padding: 12px;
      background: linear-gradient(160deg, #1a2544 0%, #111932 100%);
    }
    .stat .k { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    .stat .v { font-size: 24px; font-weight: 700; }
    .stat .m { color: #c8d5f7; font-size: 12px; margin-top: 4px; }

    .sessions { display: grid; gap: 10px; }
    .session {
      border: 1px solid #2d3e66;
      border-radius: 14px;
      background: linear-gradient(130deg, #162449 0%, #111831 60%, #111831 100%);
      position: relative;
      overflow: hidden;
      transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
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
    .session-inner { padding: 14px 52px 14px 14px; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .name { font-size: 17px; font-weight: 700; }
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
    .badge.idle { border-color: #72570f; background: #3f300c; color: #ffd98a; }

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
    .error { color: var(--red); }

    @media (max-width: 640px) {
      body { padding: 12px; }
      h1 { font-size: 22px; }
      .session-inner { padding-right: 46px; }
      .name { font-size: 16px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <h1>AI Traffic Control</h1>
    <div class="sub">Tap card: idle -> spawn, active -> connect. Use <strong>×</strong> to kill.</div>

    <section class="panel">
      <div class="stats" id="usage-grid"></div>
    </section>

    <section class="panel" style="margin-top:12px;">
      <div class="sessions" id="sessions"></div>
    </section>
  </div>

  <script>
    const refreshing = new Set();

    function esc(v) {
      return String(v)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function usageCard(title, value, meta, tone) {
      return '<article class="stat" style="border-color:' + tone + ';">' +
        '<div class="k">' + esc(title) + '</div>' +
        '<div class="v">' + esc(value) + '</div>' +
        '<div class="m">' + esc(meta || '') + '</div>' +
      '</article>';
    }

    function hostForPort(port) {
      return window.location.protocol + '//' + window.location.hostname + ':' + port;
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

    async function spawnSession(name) {
      if (refreshing.has(name)) return;
      refreshing.add(name);
      try {
        await apiPost('/api/sessions/spawn', { name: name });
      } catch (err) {
        alert('Spawn failed for ' + name + ': ' + err.message);
      } finally {
        refreshing.delete(name);
        await refresh();
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
      const actionText = isActive ? 'Tap to connect' : 'Tap to spawn';
      const actionClass = isActive ? 'color-active' : 'color-idle';

      return '<article class="session tap" data-name="' + esc(s.name) + '" data-active="' + (isActive ? '1' : '0') + '">' +
        '<button class="kill" ' + (isActive ? '' : 'disabled') + ' data-kill="1" data-name="' + esc(s.name) + '" aria-label="Kill ' + esc(s.name) + '">&times;</button>' +
        '<div class="session-inner">' +
          '<div class="head">' +
            '<div class="name">' + esc(s.name) + '</div>' +
            '<span class="badge ' + esc(isActive ? 'active' : 'idle') + '">' + esc(isActive ? 'active' : 'idle') + '</span>' +
          '</div>' +
          '<div class="line"><strong>Task:</strong> ' + esc(s.taskTitle || 'Not set') + '</div>' +
          '<div class="line"><strong>Workdir:</strong> ' + esc(s.workdir || 'Not set') + '</div>' +
          '<div class="line muted">Port ' + esc(s.publicPort) + ' -> backend ' + esc(s.backendPort) + '</div>' +
          '<div class="line muted">Agent: ' + esc(s.agentType || 'none') + ' | Turns: ' + esc((s.telemetry && s.telemetry.turnCount) ? s.telemetry.turnCount : 0) + '</div>' +
          '<div class="line muted">Context window: ' + esc((s.telemetry && Number.isFinite(Number(s.telemetry.contextWindowPct))) ? (Math.round(Number(s.telemetry.contextWindowPct)) + '%') : 'N/A') + '</div>' +
          '<div class="line muted">Active for: ' + esc(s.startedAgo || 'n/a') + ' | Last interaction: ' + esc(s.lastInteractionAgo || 'n/a') + '</div>' +
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
          if (active) {
            window.open(hostForPort(item.publicPort), '_blank', 'noopener,noreferrer');
            return;
          }
          await spawnSession(item.name);
        });
      }

      const kills = document.querySelectorAll('[data-kill="1"]');
      for (const btn of kills) {
        btn.addEventListener('click', async function (ev) {
          ev.stopPropagation();
          if (btn.hasAttribute('disabled')) return;
          const name = btn.getAttribute('data-name');
          if (!name) return;
          await killSession(name);
        });
      }
    }

    async function refresh() {
      const [usageResp, sessionsResp] = await Promise.all([
        fetch('/api/usage', { cache: 'no-store' }),
        fetch('/api/sessions', { cache: 'no-store' }),
      ]);

      const usage = await usageResp.json();
      const sessionsPayload = await sessionsResp.json();
      const sessions = sessionsPayload.sessions || [];

      const usageGrid = document.getElementById('usage-grid');
      const cards = [];
      const codex = usage.codex;
      if (codex && codex.ok) {
        if (codex.fiveHour) {
          const color = codex.fiveHour.usedPercent >= 85 ? '#b4233b' : (codex.fiveHour.usedPercent >= 70 ? '#a86a05' : '#0f8f66');
          cards.push(usageCard('Codex 5h', Math.round(codex.fiveHour.usedPercent) + '%', 'Reset in ' + (codex.fiveHour.resetIn || 'n/a'), color));
        }
        if (codex.weekly) {
          const color2 = codex.weekly.usedPercent >= 85 ? '#b4233b' : (codex.weekly.usedPercent >= 70 ? '#a86a05' : '#0f8f66');
          cards.push(usageCard('Codex weekly', Math.round(codex.weekly.usedPercent) + '%', 'Reset in ' + (codex.weekly.resetIn || 'n/a'), color2));
        }
      } else {
        cards.push(usageCard('Codex', 'Unavailable', codex?.error || 'No data', '#7d1d2c'));
      }
      cards.push(usageCard('Claude', 'soon', 'Integration queued', '#3a4c78'));
      cards.push(usageCard('Gemini', 'soon', 'Integration queued', '#3a4c78'));
      usageGrid.innerHTML = cards.join('');

      const sessionsEl = document.getElementById('sessions');
      sessionsEl.innerHTML = sessions.map(sessionCard).join('') || '<div class="line muted">No sessions configured.</div>';
      bindSessionInteractions(sessions);
    }

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

  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const codex = await getCodexUsage();
    const payload = {
      fetchedAt: new Date().toISOString(),
      codex: codex.ok
        ? {
            ...codex,
            fiveHour: codex.fiveHour
              ? { ...codex.fiveHour, resetIn: formatCountdown(codex.fiveHour.resetsAt), resetAtLocal: formatLocalTime(codex.fiveHour.resetsAt) }
              : null,
            weekly: codex.weekly
              ? { ...codex.weekly, resetIn: formatCountdown(codex.weekly.resetsAt), resetAtLocal: formatLocalTime(codex.weekly.resetsAt) }
              : null,
          }
        : codex,
      claude: { ok: false, note: 'coming soon' },
      gemini: { ok: false, note: 'coming soon' },
    };
    json(res, 200, payload);
    return;
  }

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const sessions = await getMergedSessions();
    json(res, 200, { sessions, fetchedAt: new Date().toISOString() });
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
      await spawnSlotByName(name);
      json(res, 200, { ok: true, name });
    } catch (error) {
      json(res, 500, { error: error.message || 'spawn failed' });
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
