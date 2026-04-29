/**
 * Shared e2e test harness for ATC dashboard tests.
 *
 * Provides helpers to spin up an isolated dashboard server instance with its
 * own tmp directory, sessions config, and state — then tear everything down.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DASHBOARD_ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function slotSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Safety prefix on every e2e-spawned slot/tmux name. The harness refuses to
// kill any tmux session that doesn't start with this — protecting prod sessions
// like `feynman`, `einstein`, etc. from being affected by the test suite.
export const E2E_SLOT_PREFIX = 'e2e-';

function assertSafeSlotSlug(slug) {
  if (!String(slug || '').startsWith(E2E_SLOT_PREFIX)) {
    throw new Error(
      `e2e harness refused to operate on tmux session "${slug}" — name must start with "${E2E_SLOT_PREFIX}" to avoid touching prod sessions`
    );
  }
}

/** Safe tmux kill: refuses any session that isn't an e2e-prefixed one. */
export function safeKillTmuxSession(sessionName) {
  assertSafeSlotSlug(sessionName);
  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName], {
      stdio: 'ignore',
      timeout: 3000,
    });
  } catch {
    // Ignore — session already gone is fine.
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(fn, timeoutMs = 12000, stepMs = 200) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await sleep(stepMs);
  }
  if (lastErr) throw lastErr;
  throw new Error('waitFor timeout');
}

export async function readEvents(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
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
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// DashboardHarness – spins up an isolated dashboard instance per test file.
// ---------------------------------------------------------------------------

export class DashboardHarness {
  constructor({ dashboardPort, backendPort, publicPort, telemetryIngestMs = 500 }) {
    this.dashboardPort = dashboardPort;
    this.backendPort = backendPort;
    this.publicPort = publicPort;
    this.telemetryIngestMs = telemetryIngestMs;

    // Populated during setup().
    this.tmpRoot = null;
    this.workdir = null;
    this.sessionsFile = null;
    this.stateFile = null;
    this.runDir = null;
    this.runtimeDir = null;
    this.slotName = null;
    this.eventsFile = null;
    this.dashboardProc = null;
  }

  /** Call from test.beforeAll to bootstrap everything. */
  async setup(slotPrefix = 'Test') {
    // Resolve symlinks so paths match tmux's pane_current_path (macOS /var → /private/var).
    this.tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atc-e2e-')));
    // E2E_SLOT_PREFIX guarantees the resulting tmux session name (slotSlug)
    // starts with `e2e-` and cannot collide with any prod session name.
    this.slotName = `${E2E_SLOT_PREFIX}${slotPrefix}-${Date.now().toString(36)}`;
    this.workdir = path.join(this.tmpRoot, 'workdir');
    this.sessionsFile = path.join(this.tmpRoot, 'sessions.json');
    this.stateFile = path.join(this.tmpRoot, 'state', 'sessions-state.json');
    this.runDir = path.join(this.tmpRoot, 'run');
    this.runtimeDir = path.join(this.tmpRoot, 'runtime');
    this.eventsFile = path.join(
      this.runtimeDir,
      'slots',
      slotSlug(this.slotName),
      'current',
      'events.jsonl'
    );

    await fs.mkdir(this.workdir, { recursive: true });
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });

    const sessions = [
      {
        name: this.slotName,
        publicPort: this.publicPort,
        backendPort: this.backendPort,
        description: 'e2e test slot',
      },
    ];
    await fs.writeFile(this.sessionsFile, JSON.stringify(sessions, null, 2) + '\n', 'utf8');

    this.dashboardProc = spawn(process.execPath, ['server.mjs'], {
      cwd: DASHBOARD_ROOT,
      env: {
        ...process.env,
        DASHBOARD_PORT: String(this.dashboardPort),
        SESSIONS_FILE: this.sessionsFile,
        SESSIONS_STATE_FILE: this.stateFile,
        SESSIONS_RUN_DIR: this.runDir,
        SESSIONS_RUNTIME_DIR: this.runtimeDir,
        DEFAULT_SESSION_WORKDIR: this.workdir,
        ENABLE_SHELL_HOOKS: '1',
        ENABLE_TMUX_BACKEND: '1',
        ATC_AUTO_LAUNCH_PROVIDER: '0',
        ATC_DISABLE_CODEX_BAR: '1',
        TELEMETRY_INGEST_MS: String(this.telemetryIngestMs),
        REFRESH_MS: '500',
        SPAWN_GRACE_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Drain stdout/stderr to prevent backpressure stalls.
    this.dashboardProc.stdout.on('data', () => {});
    this.dashboardProc.stderr.on('data', () => {});

    await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${this.dashboardPort}/api/sessions`);
      return res.ok;
    }, 15000);
  }

  /** Call from test.afterAll to clean up. */
  async teardown() {
    // Kill the session via the API (best-effort).
    try {
      await this.api('/api/sessions/kill', 'POST', { name: this.slotName });
    } catch {
      // Ignore.
    }

    // Kill the underlying tmux session — guarded to e2e-prefixed names only.
    safeKillTmuxSession(slotSlug(this.slotName));

    // Terminate the dashboard process.
    if (this.dashboardProc && !this.dashboardProc.killed) {
      this.dashboardProc.kill('SIGTERM');
      await sleep(500);
      if (this.dashboardProc.exitCode === null) {
        this.dashboardProc.kill('SIGKILL');
      }
    }

    // Remove temp directory.
    if (this.tmpRoot) {
      await fs.rm(this.tmpRoot, { recursive: true, force: true });
    }
  }

  /** Convenience wrapper around fetch for dashboard API calls. */
  async api(pathname, method = 'GET', payload = undefined) {
    const response = await fetch(`http://127.0.0.1:${this.dashboardPort}${pathname}`, {
      method,
      headers: payload ? { 'content-type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${method} ${pathname} failed: ${response.status} ${body.error || ''}`.trim());
    }
    return body;
  }

  /** Spawn the session and wait for the backend to become active. */
  async spawnAndWaitForBackend(timeoutMs = 12000, payload = {}) {
    await this.api('/api/sessions/spawn', 'POST', { name: this.slotName, ...payload });
    await waitFor(async () => {
      const sessions = await this.api('/api/sessions');
      const slot = sessions.sessions.find((s) => s.name === this.slotName);
      return slot && slot.backendActive;
    }, timeoutMs);
  }

  /** Return the tmux session name for the test slot. */
  tmuxSessionName() {
    return slotSlug(this.slotName);
  }

  /** Get the current session object from the dashboard API. */
  async getSession() {
    const payload = await this.api('/api/sessions');
    return payload.sessions.find((s) => s.name === this.slotName) || null;
  }
}
