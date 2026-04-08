import { test, expect } from '@playwright/test';
import { DashboardHarness } from './harness.mjs';

const DASHBOARD_PORT = 19114;
const BACKEND_PORT = 18104;
const PUBLIC_PORT = 17104;

const harness = new DashboardHarness({
  dashboardPort: DASHBOARD_PORT,
  backendPort: BACKEND_PORT,
  publicPort: PUBLIC_PORT,
});

test.beforeAll(async () => {
  await harness.setup('Einstein');
});

test.afterAll(async () => {
  await harness.teardown();
});

test('persona can be selected at start time and persists in session state', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}`, { waitUntil: 'domcontentloaded' });

  await page.locator('.session.tap').first().click();
  await expect(page.locator('#intent-modal')).toHaveClass(/open/);

  await page.locator('[data-persona-id="tester"]').click();
  await page.locator('#intent-confirm').click();

  await expect
    .poll(async () => {
      const session = await harness.getSession();
      return session ? { personaId: session.personaId, status: session.status } : null;
    }, {
      timeout: 12000,
      message: 'expected persona selection to persist into session state',
    })
    .toMatchObject({
      personaId: 'tester',
      status: 'active',
    });

  await expect
    .poll(async () => {
      const session = await harness.getSession();
      return session?.personaId || null;
    }, {
      timeout: 12000,
      message: 'expected dashboard API to expose personaId',
    })
    .toBe('tester');

  await expect(page.locator('[data-persona-badge="1"]')).toHaveText('Tester');
});
