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
  await harness.api('/api/sessions/update', 'POST', {
    name: harness.slotName,
    picturePath: 'scientists/einstein.jpg',
  });
});

test.afterAll(async () => {
  await harness.teardown();
});

test('persona cycles within the allowed template set and persists in session state', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}`, { waitUntil: 'domcontentloaded' });

  await page.locator('.session.tap').first().click();
  await expect(page.locator('#intent-modal')).toHaveClass(/open/);
  await expect(page.locator('#intent-scientist img.intent-scientist-image')).toBeVisible();
  await expect(page.locator('.persona-select-card')).toHaveCount(1);
  await expect(page.locator('.persona-select-name')).toHaveText('Vanilla');

  await page.locator('#persona-next').click();
  await expect(page.locator('.persona-select-name')).toHaveText('Brainstormer');
  await expect(page.locator('#intent-scientist svg.intent-scientist-hat')).toBeVisible();

  await page.locator('#template-continue').click();
  await expect(page.locator('.persona-select-name')).toHaveText('Vanilla');

  await page.locator('#persona-next').click();
  await page.locator('#persona-next').click();
  await expect(page.locator('.persona-select-name')).toHaveText('Tester');

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

  await harness.api('/api/sessions/kill', 'POST', {
    name: harness.slotName,
  });

  await expect
    .poll(async () => {
      const session = await harness.getSession();
      return session ? { personaId: session.personaId, status: session.status } : null;
    }, {
      timeout: 12000,
      message: 'expected persona state to clear after kill',
    })
    .toMatchObject({
      personaId: 'none',
      status: 'idle',
    });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-persona-badge="1"]')).toHaveCount(0);

  await page.locator('.session.tap').first().click();
  await expect(page.locator('.persona-select-name')).toHaveText('Vanilla');
  await expect(page.locator('#intent-scientist svg.intent-scientist-hat')).toHaveCount(0);
});
