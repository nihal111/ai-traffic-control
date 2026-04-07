import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DASHBOARD_PORT = 19111;
const BACKEND_PORT = 18101;
const PUBLIC_PORT = 17101;

let tmpRoot;
let workdir;
let sessionsFile;
let stateFile;
let runDir;
let runtimeDir;
let dashboardProc;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_ROOT = path.resolve(__dirname, '../..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 12000, stepMs = 200) {
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

async function api(pathname, method = 'GET', payload = undefined) {
  const response = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}${pathname}`, {
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

test.beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atc-e2e-'));
  workdir = path.join(tmpRoot, 'workdir');
  sessionsFile = path.join(tmpRoot, 'sessions.json');
  stateFile = path.join(tmpRoot, 'state', 'sessions-state.json');
  runDir = path.join(tmpRoot, 'run');
  runtimeDir = path.join(tmpRoot, 'runtime');

  await fs.mkdir(workdir, { recursive: true });
  await fs.mkdir(path.dirname(stateFile), { recursive: true });

  const sessions = [
    {
      name: 'Feynman',
      publicPort: PUBLIC_PORT,
      backendPort: BACKEND_PORT,
      description: 'test slot',
    },
  ];
  await fs.writeFile(sessionsFile, JSON.stringify(sessions, null, 2) + '\n', 'utf8');

  dashboardProc = spawn(process.execPath, ['server.mjs'], {
    cwd: DASHBOARD_ROOT,
    env: {
      ...process.env,
      DASHBOARD_PORT: String(DASHBOARD_PORT),
      SESSIONS_FILE: sessionsFile,
      SESSIONS_STATE_FILE: stateFile,
      SESSIONS_RUN_DIR: runDir,
      SESSIONS_RUNTIME_DIR: runtimeDir,
      DEFAULT_SESSION_WORKDIR: workdir,
      ENABLE_SHELL_HOOKS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  dashboardProc.stdout.on('data', () => {});
  dashboardProc.stderr.on('data', () => {});

  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/sessions`);
    return res.ok;
  }, 15000);
});

test.afterAll(async () => {
  try {
    await api('/api/sessions/kill', 'POST', { name: 'Feynman' });
  } catch {
    // Ignore cleanup failures.
  }

  if (dashboardProc && !dashboardProc.killed) {
    dashboardProc.kill('SIGTERM');
    await sleep(500);
    if (dashboardProc.exitCode === null) {
      dashboardProc.kill('SIGKILL');
    }
  }

  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('spawned ttyd terminal executes keystrokes and writes expected file', async ({ page }) => {
  const markerFile = path.join(workdir, `terminal-smoke-${Date.now()}.txt`);

  await api('/api/sessions/spawn', 'POST', { name: 'Feynman' });

  await waitFor(async () => {
    const sessions = await api('/api/sessions');
    const slot = sessions.sessions.find((s) => s.name === 'Feynman');
    return slot && slot.backendActive;
  }, 12000);

  await page.goto(`http://127.0.0.1:${BACKEND_PORT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 15000 });

  // Focus terminal and execute a command purely through keystrokes.
  await page.locator('.xterm').click({ position: { x: 120, y: 120 } });
  const cmd = `printf 'atc-terminal-e2e-ok\\n' > ${markerFile}`;
  await page.keyboard.type(cmd, { delay: 15 });
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => {
      try {
        const text = await fs.readFile(markerFile, 'utf8');
        return text.trim();
      } catch {
        return '';
      }
    }, {
      timeout: 10000,
      message: `expected terminal command to create ${markerFile}`,
    })
    .toBe('atc-terminal-e2e-ok');

  await api('/api/sessions/kill', 'POST', { name: 'Feynman' });
});
