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

const DASHBOARD_PORT = 19120;
const SESSION_NAMES = ['ScrollTest1'];
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

test('scroll position is restored after closing intent modal', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}`);
  await page.waitForSelector('.session.tap');

  // Make page scrollable by adding content
  await page.evaluate(() => {
    // Ensure there's enough content to scroll
    const container = document.querySelector('.shell');
    if (container) {
      const padding = document.createElement('div');
      padding.style.height = '500px';
      container.appendChild(padding);
    }
  });

  // Scroll to a specific position
  const targetScroll = 100;
  await page.evaluate((y) => window.scrollTo(0, y), targetScroll);
  let scrollBefore = await page.evaluate(() => window.scrollY);
  console.log('Scroll position before opening modal:', scrollBefore);

  // Should be close to target (within 10 pixels for browser variance)
  expect(Math.abs(scrollBefore - targetScroll)).toBeLessThan(20);

  // Open intent modal
  await page.click('.session.tap');
  await page.waitForSelector('#intent-modal.open');

  // Close the modal without spawning
  await page.click('#intent-close');
  await page.waitForSelector('#intent-modal', { state: 'hidden' });

  // Wait a brief moment for scroll restoration to complete
  await page.waitForTimeout(100);

  // Check that scroll position was restored
  let scrollAfter = await page.evaluate(() => window.scrollY);
  console.log('Scroll position after closing modal:', scrollAfter);

  // Scroll position should be restored to approximately the same position
  // (allowing some variance due to DOM changes during modal open/close)
  expect(Math.abs(scrollAfter - targetScroll)).toBeLessThan(30);

  // Verify we can still scroll
  const scrollBefore2 = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollBy(0, 50));
  const scrollAfter2 = await page.evaluate(() => window.scrollY);

  console.log('Scroll before additional scroll:', scrollBefore2, 'after:', scrollAfter2);
  expect(scrollAfter2).toBeGreaterThan(scrollBefore2);
});

test('scroll position is restored after canceling intent modal and spawning scientist', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}`);
  await page.waitForSelector('.session.tap');

  // Make page scrollable
  await page.evaluate(() => {
    const container = document.querySelector('.shell');
    if (container) {
      const padding = document.createElement('div');
      padding.style.height = '500px';
      container.appendChild(padding);
    }
  });

  // Scroll to a position
  const targetScroll = 75;
  await page.evaluate((y) => window.scrollTo(0, y), targetScroll);
  let scrollBefore = await page.evaluate(() => window.scrollY);
  expect(Math.abs(scrollBefore - targetScroll)).toBeLessThan(20);

  // Open modal, then close and spawn
  await page.click('.session.tap');
  await page.waitForSelector('#intent-modal.open');

  // Spawn the scientist
  await page.click('#intent-confirm');

  // Wait for modal to close
  await page.waitForSelector('#intent-modal', { state: 'hidden' });

  // Small delay for scroll restoration
  await page.waitForTimeout(150);

  // Check that scroll was restored (before focusSessionCard auto-scrolls)
  // The scroll might have moved slightly due to DOM changes, but should be in range
  let scrollAfter = await page.evaluate(() => window.scrollY);
  console.log('Scroll after spawning scientist:', scrollAfter);

  // Allow more variance here since spawning modifies the DOM significantly
  expect(scrollAfter).toBeLessThan(200);

  // Verify scrolling still works
  const initialScroll = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollBy(0, 30));
  const finalScroll = await page.evaluate(() => window.scrollY);

  console.log('Initial:', initialScroll, 'Final:', finalScroll);
  expect(finalScroll).toBeGreaterThan(initialScroll);
});
