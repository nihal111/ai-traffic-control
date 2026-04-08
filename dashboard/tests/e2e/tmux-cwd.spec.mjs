/**
 * Tests that the dashboard workdir reflects the live tmux pane working
 * directory — even when shell hook events are stale or absent.
 *
 * Reproduces the bug where a user connects to a scientist session, changes
 * directory, but the dashboard keeps showing the original workdir because
 * event-derived cwd took priority over the live tmux pane_current_path.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DashboardHarness, waitFor } from './harness.mjs';

const DASHBOARD_PORT = 19211;
const BACKEND_PORT = 18201;
const PUBLIC_PORT = 17201;

const harness = new DashboardHarness({
  dashboardPort: DASHBOARD_PORT,
  backendPort: BACKEND_PORT,
  publicPort: PUBLIC_PORT,
});

test.beforeAll(async () => {
  await harness.setup('CwdTest');
});

test.afterAll(async () => {
  await harness.teardown();
});

test('dashboard workdir tracks live tmux pane_current_path across cd navigations', async () => {
  const sessionName = harness.tmuxSessionName();

  // 1. Spawn the session and wait for its backend (ttyd) to start.
  await harness.spawnAndWaitForBackend();

  // 2. Verify the initial workdir from the dashboard API matches the default.
  const initial = await harness.getSession();
  expect(initial).toBeTruthy();
  expect(initial.backendActive).toBe(true);
  expect(initial.workdir).toBe(harness.workdir);

  // 3. Create target directories.
  const targetDir = path.join(harness.tmpRoot, 'cwd-target');
  const secondDir = path.join(harness.tmpRoot, 'cwd-second');
  await fs.mkdir(targetDir, { recursive: true });
  await fs.mkdir(secondDir, { recursive: true });

  // 4. Wait for the tmux shell to be ready by checking for shell_start event.
  await waitFor(async () => {
    try {
      const eventsRaw = await fs.readFile(harness.eventsFile, 'utf8');
      return eventsRaw.includes('"shell_start"');
    } catch {
      return false;
    }
  }, 15000);

  // 5. Change directory via tmux send-keys (simulates user typing in terminal).
  execFileSync('tmux', ['send-keys', '-t', sessionName, `cd ${targetDir}`, 'Enter'], {
    timeout: 3000,
  });

  // 6. Wait for tmux pane_current_path to reflect the new directory.
  await waitFor(() => {
    try {
      const output = execFileSync(
        'tmux',
        ['list-panes', '-t', sessionName, '-F', '#{pane_current_path}'],
        { encoding: 'utf8', timeout: 3000 }
      );
      return output.trim() === targetDir;
    } catch {
      return false;
    }
  }, 8000, 300);

  // 7. Poll the dashboard API until the workdir matches the tmux cwd.
  await expect
    .poll(
      async () => {
        const session = await harness.getSession();
        return session?.workdir;
      },
      {
        timeout: 10000,
        message: `expected dashboard workdir to update to ${targetDir} (live tmux cwd)`,
      }
    )
    .toBe(targetDir);

  // 8. Navigate to a second directory and verify the workdir updates again.
  execFileSync('tmux', ['send-keys', '-t', sessionName, `cd ${secondDir}`, 'Enter'], {
    timeout: 3000,
  });

  await waitFor(() => {
    try {
      const output = execFileSync(
        'tmux',
        ['list-panes', '-t', sessionName, '-F', '#{pane_current_path}'],
        { encoding: 'utf8', timeout: 3000 }
      );
      return output.trim() === secondDir;
    } catch {
      return false;
    }
  }, 8000, 300);

  await expect
    .poll(
      async () => {
        const session = await harness.getSession();
        return session?.workdir;
      },
      {
        timeout: 10000,
        message: `expected dashboard workdir to update to ${secondDir} on second cd`,
      }
    )
    .toBe(secondDir);
});
