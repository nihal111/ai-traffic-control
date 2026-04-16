import { test, expect } from '@playwright/test';
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

const DASHBOARD_PORT = 19118;
const SESSION_NAMES = ['Alpha', 'Bravo', 'Charlie'];
const SLOT_PORTS = [
  { publicPort: 17111, backendPort: 18111 },
  { publicPort: 17112, backendPort: 18112 },
  { publicPort: 17113, backendPort: 18113 },
];

let tmpRoot = null;
let dashboardProc = null;

test.beforeAll(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atc-e2e-stability-')));
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
        description: 'e2e stability slot',
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

test.afterAll(async () => {
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

  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('only target scientist card remounts while spawning', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}`);
  await page.waitForSelector('.session.tap[data-name="Alpha"]');
  await page.waitForSelector('.session.tap[data-name="Bravo"]');
  await page.waitForSelector('.session.tap[data-name="Charlie"]');

  await page.evaluate(() => {
    window.__atcAlphaNode = document.querySelector('.session.tap[data-name="Alpha"]');
    window.__atcCharlieNode = document.querySelector('.session.tap[data-name="Charlie"]');
  });

  await page.locator('.session.tap[data-name="Bravo"]').click();
  await page.waitForSelector('#intent-modal.open');
  await page.click('#intent-confirm');

  await page.waitForFunction(() => {
    const bravo = document.querySelector('.session.tap[data-name="Bravo"]');
    return !!bravo && bravo.getAttribute('data-spawning') === '1';
  });

  const identity = await page.evaluate(() => {
    const alphaNow = document.querySelector('.session.tap[data-name="Alpha"]');
    const charlieNow = document.querySelector('.session.tap[data-name="Charlie"]');
    return {
      alphaSame: alphaNow === window.__atcAlphaNode,
      charlieSame: charlieNow === window.__atcCharlieNode,
    };
  });

  expect(identity.alphaSame).toBeTruthy();
  expect(identity.charlieSame).toBeTruthy();
});
