import { test, expect, devices } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { slotSlug, safeKillTmuxSession } from './harness.mjs';

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

const DASHBOARD_PORT = 19120;
const SESSION_NAMES = ['e2e-ScrollTest1'];
const SLOT_PORTS = [
  { publicPort: 17130, backendPort: 18130 },
];

let tmpRoot = null;
let dashboardProc = null;

test.beforeAll(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atc-e2e-scroll-restore-')));
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
        description: 'e2e scroll restoration test',
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
      REFRESH_MS: '500',
      SPAWN_GRACE_MS: '500',
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
    for (const name of SESSION_NAMES) {
      await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/sessions/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    }
  } catch {
    // ignore
  }

  for (const name of SESSION_NAMES) {
    safeKillTmuxSession(slotSlug(name));
  }

  if (dashboardProc && !dashboardProc.killed) {
    dashboardProc.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (dashboardProc.exitCode === null) dashboardProc.kill('SIGKILL');
  }

  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('scroll position is restored after closing intent modal', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}`);
  await page.waitForSelector('.session.tap');

  // Make page scrollable. Append to <body> (not .shell) so the dashboard's
  // re-render after spawn doesn't wipe out our padding.
  await page.evaluate(() => {
    if (!document.getElementById('atc-test-padding')) {
      const padding = document.createElement('div');
      padding.id = 'atc-test-padding';
      padding.style.height = '500px';
      document.body.appendChild(padding);
    }
  });

  // Scroll to a specific position. The padding above is async-applied to layout;
  // poll until the scrollTo actually sticks before continuing.
  const targetScroll = 100;
  await page.waitForFunction(
    (y) => {
      window.scrollTo(0, y);
      return Math.abs(window.scrollY - y) < 20;
    },
    targetScroll,
    { timeout: 3000 }
  );
  let scrollBefore = await page.evaluate(() => window.scrollY);
  expect(Math.abs(scrollBefore - targetScroll)).toBeLessThan(20);

  // Open intent modal
  await page.click('.session.tap');
  await page.waitForSelector('#intent-modal.open');
  const lockedScroll = await page.evaluate(() => {
    const top = Number.parseInt(document.body.style.top || '0', 10);
    return Number.isFinite(top) ? Math.abs(top) : 0;
  });

  // Close the modal without spawning
  await page.click('#intent-close');
  await page.waitForSelector('#intent-modal', { state: 'hidden' });

  // Wait for scroll restoration (there are two scrollTo calls: immediate + rAF).
  await waitFor(async () => {
    const y = await page.evaluate(() => window.scrollY);
    return Math.abs(y - lockedScroll) <= 12;
  }, 2500, 60);
  // Flush rAF so the post-close scrollTo(0, restoreY) inside requestAnimationFrame
  // fires before we probe with scrollBy — otherwise it clobbers our delta.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );

  // Check that scroll position was restored
  let scrollAfter = await page.evaluate(() => window.scrollY);
  console.log('Scroll position after closing modal:', scrollAfter);

  // Restore target is the actual lock offset captured when the modal opened.
  expect(Math.abs(scrollAfter - lockedScroll)).toBeLessThan(15);

  // Verify scrolling is not locked. If we're already at max scroll, no movement is expected.
  const scrollBefore2 = await page.evaluate(() => window.scrollY);
  const maxScroll = await page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, (doc?.scrollHeight || 0) - window.innerHeight);
  });
  await page.evaluate(() => window.scrollBy(0, 50));
  const scrollAfter2 = await page.evaluate(() => window.scrollY);

  console.log('Scroll before additional scroll:', scrollBefore2, 'after:', scrollAfter2);
  if (scrollBefore2 >= maxScroll - 1) {
    expect(Math.abs(scrollAfter2 - scrollBefore2)).toBeLessThan(2);
  } else {
    expect(scrollAfter2).toBeGreaterThan(scrollBefore2);
  }
});

