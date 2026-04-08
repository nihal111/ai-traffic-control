import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DashboardHarness, waitFor, readEvents } from './harness.mjs';

const DASHBOARD_PORT = 19111;
const BACKEND_PORT = 18101;
const PUBLIC_PORT = 17101;

const harness = new DashboardHarness({
  dashboardPort: DASHBOARD_PORT,
  backendPort: BACKEND_PORT,
  publicPort: PUBLIC_PORT,
});

test.beforeAll(async () => {
  await harness.setup('Feynman');
});

test.afterAll(async () => {
  await harness.teardown();
});

test('shell hooks emit full telemetry and dashboard exposes derived metadata', async ({ page }) => {
  const markerFile = path.join(harness.workdir, `terminal-smoke-${Date.now()}.txt`);
  const subdir = path.join(harness.workdir, 'hook-cwd');
  const pwdFile = path.join(harness.workdir, `hook-pwd-${Date.now()}.txt`);

  await harness.spawnAndWaitForBackend();

  await page.goto(`http://127.0.0.1:${BACKEND_PORT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 15000 });

  await expect
    .poll(async () => {
      try {
        const rows = await readEvents(harness.eventsFile);
        return rows.some((row) => row.eventType === 'shell_start');
      } catch {
        return false;
      }
    }, {
      timeout: 10000,
      message: 'expected shell_start hook event before typing commands',
    })
    .toBe(true);

  // Focus terminal and execute commands purely through keystrokes.
  await page.locator('.xterm').click({ position: { x: 120, y: 120 } });
  await page.keyboard.type(`mkdir -p ${subdir}`, { delay: 12 });
  await page.keyboard.press('Enter');
  await page.keyboard.type(`cd ${subdir}`, { delay: 12 });
  await page.keyboard.press('Enter');
  await page.keyboard.type(`pwd > ${pwdFile}`, { delay: 12 });
  await page.keyboard.press('Enter');
  await page.keyboard.type(`printf 'atc-terminal-e2e-ok\\n' > ${markerFile}`, { delay: 12 });
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

  await expect
    .poll(async () => {
      try {
        const rows = await readEvents(harness.eventsFile);
        const hasPreexec = rows.some((row) => row.eventType === 'preexec' && typeof row.command === 'string' && row.command.includes(markerFile));
        const hasPrecmd = rows.some((row) => row.eventType === 'precmd');
        const hasChpwd = rows.some(
          (row) => row.eventType === 'chpwd' && typeof row.cwd === 'string' && (row.cwd === subdir || row.cwd.endsWith('/hook-cwd'))
        );
        return hasPreexec && hasPrecmd && hasChpwd;
      } catch {
        return false;
      }
    }, {
      timeout: 10000,
      message: 'expected shell hooks to record preexec/precmd/chpwd events',
    })
    .toBe(true);

  await expect
    .poll(async () => {
      try {
        const text = await fs.readFile(pwdFile, 'utf8');
        return text.trim();
      } catch {
        return '';
      }
    }, {
      timeout: 10000,
      message: `expected pwd output to be written to ${pwdFile}`,
    })
    .toBe(subdir);

  await expect
    .poll(async () => {
      const payload = await harness.api('/api/sessions');
      const slot = payload.sessions.find((s) => s.name === harness.slotName);
      if (!slot?.telemetry) return null;
      return {
        cwd: slot.workdir,
        activeSince: slot.activeSince,
        lastInteractionAgo: slot.lastInteractionAgo,
        lastEventType: slot.telemetry.lastEventType,
        lastCommand: slot.telemetry.lastCommand,
        durationMs: slot.telemetry.durationMs,
      };
    }, {
      timeout: 12000,
      message: 'expected dashboard session API to expose derived shell telemetry',
    })
    .toMatchObject({
      cwd: subdir,
      activeSince: expect.any(String),
      lastEventType: 'precmd',
      lastCommand: expect.stringContaining(markerFile),
      lastInteractionAgo: expect.stringMatching(/ago$/),
    });

  await expect
    .poll(async () => {
      const payload = await harness.api('/api/sessions');
      const slot = payload.sessions.find((s) => s.name === harness.slotName);
      return Number(slot?.telemetry?.durationMs);
    }, {
      timeout: 12000,
      message: 'expected numeric command duration in derived telemetry',
    })
    .toBeGreaterThanOrEqual(0);

  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}`, { waitUntil: 'domcontentloaded' });
  const cardText = await page.locator('.session').first().innerText();
  expect(cardText).not.toContain('Port ');
  expect(cardText).not.toContain('backend');
  expect(cardText).not.toContain('Interactive shell session');
  expect(cardText).not.toContain('Last event:');
  expect(cardText).not.toContain('Last cmd duration:');

  await harness.api('/api/sessions/kill', 'POST', { name: harness.slotName });
});
