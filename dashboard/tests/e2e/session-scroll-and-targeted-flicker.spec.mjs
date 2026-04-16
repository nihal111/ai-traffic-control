import { test, expect, devices } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

function slotSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function waitFor(fn, timeoutMs = 12000, stepMs = 200) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  if (lastErr) throw lastErr;
  throw new Error('waitFor timeout');
}

const DASHBOARD_PORT = 19119;
const SESSION_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
const SLOT_PORTS = [
  { publicPort: 17121, backendPort: 18121 },
  { publicPort: 17122, backendPort: 18122 },
  { publicPort: 17123, backendPort: 18123 },
  { publicPort: 17124, backendPort: 18124 },
];

let tmpRoot = null;
let dashboardProc = null;

test.use({
  ...devices['iPhone 13'],
});

async function api(pathname, method = 'GET', payload = undefined) {
  const response = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}${pathname}`, {
    method,
    headers: payload ? { 'content-type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathname} failed: ${response.status} ${body.error || ''}`.trim());
  return body;
}

test.beforeAll(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atc-e2e-scroll-')));
  const sessionsFile = path.join(tmpRoot, 'sessions.json');
  const stateFile = path.join(tmpRoot, 'state', 'sessions-state.json');
  const runDir = path.join(tmpRoot, 'run');
  const runtimeDir = path.join(tmpRoot, 'runtime');
  const workdir = path.join(tmpRoot, 'workdir');

  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.mkdir(workdir, { recursive: true });
  await fs.writeFile(
    sessionsFile,
    JSON.stringify(
      SESSION_NAMES.map((name, index) => ({
        name,
        ...SLOT_PORTS[index],
        description: 'e2e scroll + flicker slot',
      })),
      null,
      2
    ) + '\n',
    'utf8'
  );

  dashboardProc = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve(process.cwd(), '.'),
    env: {
      ...process.env,
      DASHBOARD_PORT: String(DASHBOARD_PORT),
      SESSIONS_FILE: sessionsFile,
      SESSIONS_STATE_FILE: stateFile,
      SESSIONS_RUN_DIR: runDir,
      SESSIONS_RUNTIME_DIR: runtimeDir,
      DEFAULT_SESSION_WORKDIR: workdir,
      ENABLE_SHELL_HOOKS: '1',
      ENABLE_TMUX_BACKEND: '1',
      ATC_AUTO_LAUNCH_PROVIDER: '0',
      ATC_DISABLE_CODEX_BAR: '1',
      REFRESH_MS: '2000',
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

async function waitForBackend(name, timeoutMs = 15000) {
  await waitFor(async () => {
    const payload = await api('/api/sessions');
    const slot = (payload.sessions || []).find((s) => s.name === name);
    return !!(slot && slot.backendActive);
  }, timeoutMs);
}

async function resetAllIdle() {
  for (const name of SESSION_NAMES) {
    try {
      await api('/api/sessions/kill', 'POST', { name });
    } catch {
      // ignore
    }
  }
}

test.beforeEach(async () => {
  await resetAllIdle();
});

test.afterAll(async () => {
  try {
    for (const name of SESSION_NAMES) {
      await api('/api/sessions/kill', 'POST', { name });
    }
  } catch {
    // ignore
  }

  for (const name of SESSION_NAMES) {
    try {
      execFileSync('tmux', ['kill-session', '-t', slotSlug(name)], {
        stdio: 'ignore',
        timeout: 3000,
      });
    } catch {
      // ignore
    }
  }

  if (dashboardProc && !dashboardProc.killed) {
    dashboardProc.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (dashboardProc.exitCode === null) dashboardProc.kill('SIGKILL');
  }

  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('starting fourth scientist does not force scroll-top and targets only that card', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}`);
  await page.waitForSelector('.session.tap[data-name="Delta"]');

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const beforeOpen = await page.evaluate(() => window.scrollY);
  expect(beforeOpen).toBeGreaterThan(20);

  await page.locator('.session.tap[data-name="Delta"]').click();
  await page.waitForSelector('#intent-modal.open');
  // When the body-scroll-lock is active, body.style.position === 'fixed' and
  // window.scrollY returns 0. Read the saved offset from body.style.top instead.
  const modalOpenScroll = await page.evaluate(() => {
    const body = document.body;
    if (body.style.position === 'fixed') return Math.abs(parseInt(body.style.top || '0', 10));
    return window.scrollY;
  });
  expect(modalOpenScroll).toBeGreaterThan(20);

  await page.click('#intent-confirm');

  await page.waitForFunction(() => {
    const delta = document.querySelector('.session.tap[data-name="Delta"]');
    return !!delta && delta.getAttribute('data-spawning') === '1';
  });
  const postStartScroll = await page.evaluate(() => window.scrollY);
  expect(postStartScroll).toBeGreaterThan(20);

  const spawningByName = await page.$$eval('.session.tap[data-name]', (nodes) =>
    nodes.map((el) => ({
      name: el.getAttribute('data-name'),
      spawning: el.getAttribute('data-spawning'),
    }))
  );
  const delta = spawningByName.find((x) => x.name === 'Delta');
  const alpha = spawningByName.find((x) => x.name === 'Alpha');
  expect(delta?.spawning).toBe('1');
  expect(alpha?.spawning).toBe('0');
});

test('hot dial auto-scrolls and flickers the deterministic selected scientist', async ({ page }) => {
  await api('/api/sessions/spawn', 'POST', { name: 'Alpha' });
  await waitForBackend('Alpha');
  await api('/api/sessions/spawn', 'POST', { name: 'Bravo' });
  await waitForBackend('Bravo');
  await api('/api/sessions/spawn', 'POST', { name: 'Charlie' });
  await waitForBackend('Charlie');

  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}`);
  await page.waitForSelector('.session.tap[data-name="Delta"]');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('[data-agent-dial-id="calendar_manager"]');
  await page.waitForSelector('#agent-modal.open');
  const spawnResponsePromise = page.waitForResponse((resp) =>
    resp.url().includes('/api/agents/spawn') && resp.request().method() === 'POST'
  );
  await page.click('#agent-confirm');
  const spawnResponse = await spawnResponsePromise;
  const spawnBody = await spawnResponse.json();
  expect(spawnBody.slotName).toBe('Delta');

  await page.waitForFunction(() => {
    const delta = document.querySelector('.session.tap[data-name="Delta"]');
    return !!delta && delta.getAttribute('data-active') === '1';
  });

  const inView = await page.evaluate(() => {
    const card = document.querySelector('.session.tap[data-name="Delta"]');
    if (!card) return false;
    const rect = card.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  });
  expect(inView).toBeTruthy();

  const spawningByName = await page.$$eval('.session.tap[data-name]', (nodes) =>
    nodes.map((el) => ({
      name: el.getAttribute('data-name'),
      spawning: el.getAttribute('data-spawning'),
      active: el.getAttribute('data-active'),
    }))
  );
  const delta = spawningByName.find((x) => x.name === 'Delta') || {};
  const alpha = spawningByName.find((x) => x.name === 'Alpha') || {};
  expect(delta.active).toBe('1');
  expect(alpha.active).toBe('1');
});
