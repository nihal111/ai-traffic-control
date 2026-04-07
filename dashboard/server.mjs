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
const TTYD_BIN = process.env.TTYD_BIN || '/opt/homebrew/bin/ttyd';
const SHELL_BIN = process.env.SHELL_BIN || '/bin/zsh';
const DEFAULT_WORKDIR = process.env.DEFAULT_SESSION_WORKDIR || '/Users/nihal/Code/MobileDev';
const REFRESH_MS = 8000;
const USAGE_TTL_MS = 10000;

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
  const tmp = `${STATE_FILE}.tmp`;
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

async function spawnSessionBackend(slot, sessionState) {
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
      env: {
        ...process.env,
        DASH_SLOT_NAME: slot.name,
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
}

async function getMergedSessions() {
  const [cfg, state] = await Promise.all([readSessionsConfig(), loadState()]);
  const merged = await Promise.all(
    cfg.map(async (slot) => {
      const st = state.sessions[slot.name] || defaultSessionState(slot);
      const active = await checkPortOpen(slot.publicPort);
      const backendActive = await checkPortOpen(slot.backendPort);

      if (st.status === 'active' && !backendActive) {
        st.status = 'idle';
        st.pid = null;
        st.lastExitAt = new Date().toISOString();
      }

      return {
        ...slot,
        ...st,
        active,
        backendActive,
        startedAgo: st.spawnedAt ? durationSince(st.spawnedAt) : 'n/a',
        lastInteractionAgo: st.lastInteractionAt ? ago(st.lastInteractionAt) : 'n/a',
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

  const pid = await spawnSessionBackend(slot, st);
  st.status = 'active';
  st.pid = pid;
  st.error = null;
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

  st.status = 'idle';
  st.pid = null;
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
  <title>Scientist Sessions Dashboard</title>
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
    <h1>Scientist Session Control</h1>
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`dashboard listening on http://0.0.0.0:${PORT}`);
});
