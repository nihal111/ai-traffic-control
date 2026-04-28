import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { DashboardHarness, waitFor } from './harness.mjs';

const DASHBOARD_PORT = 19142;
const BACKEND_PORT = 18142;
const PUBLIC_PORT = 17142;

const harness = new DashboardHarness({
  dashboardPort: DASHBOARD_PORT,
  backendPort: BACKEND_PORT,
  publicPort: PUBLIC_PORT,
});

test.beforeAll(async () => {
  await harness.setup('OrphanReap');
});

test.afterAll(async () => {
  await harness.teardown();
});

test('dashboard reaps an orphaned tmux session instead of leaving it active', async () => {
  await harness.spawnAndWaitForBackend();

  const session = await harness.getSession();
  expect(session).toBeTruthy();
  expect(session.backendActive).toBe(true);

  execFileSync('tmux', ['kill-session', '-t', harness.tmuxSessionName()], {
    timeout: 3000,
  });

  await waitFor(async () => {
    const next = await harness.getSession();
    return next && next.status === 'idle' && !next.backendActive;
  }, 15000);

  const cleaned = await harness.getSession();
  expect(cleaned.status).toBe('idle');
  expect(cleaned.backendActive).toBe(false);
});
