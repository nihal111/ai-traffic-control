import { defineConfig } from '@playwright/test';
import os from 'node:os';

const cpuCount = os.cpus().length;
// Each spec spawns its own dashboard + tmux + ttyd + (sometimes) real Codex.
// 3 is the sweet spot: 4 starves agent-metadata-reset under contention,
// 2 doubles wall-clock for marginal stability gain.
const defaultWorkers = Math.min(3, Math.max(2, Math.floor(cpuCount / 2)));

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.mjs$/,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: process.env.PWTEST_WORKERS ? Number(process.env.PWTEST_WORKERS) : defaultWorkers,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
});
