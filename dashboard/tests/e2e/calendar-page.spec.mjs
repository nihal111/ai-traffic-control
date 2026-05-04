/**
 * Calendar page tests — exercise the dashboard's /calendar HTML/JS only.
 *
 * The calendar APIs (/api/calendar/state, /api/calendar/backlog) shell out to
 * Python in ../CalendarAutomation. Those scripts are out of scope for the
 * dashboard test suite, so we mock them at the network layer with page.route()
 * and assert how the page renders/handles each response shape.
 */

import { test, expect } from '@playwright/test';
import { DashboardHarness } from './harness.mjs';

const DASHBOARD_PORT = 19124;
const BACKEND_PORT = 18124;
const PUBLIC_PORT = 17124;

const harness = new DashboardHarness({
  dashboardPort: DASHBOARD_PORT,
  backendPort: BACKEND_PORT,
  publicPort: PUBLIC_PORT,
});

const FAKE_STATE = {
  brief: { lines: ['Standup at 10am', 'Lunch at noon'] },
  open_slots_today: [{ start: '2026-04-29T15:00:00-07:00', minutes: 30 }],
  backlog: [],
  updated_at: '2026-04-29T09:00:00-07:00',
};

const FAKE_BACKLOG = {
  items: [
    { id: 'bk_1', title: 'Test backlog item', status: 'pending', priority: 'normal' },
  ],
};

test.beforeAll(async () => {
  await harness.setup('CalendarPage');
});

test.afterAll(async () => {
  await harness.teardown();
});

test.beforeEach(async ({ page }) => {
  // Default: fulfill calendar APIs with deterministic JSON so the page can render.
  await page.route(/\/api\/calendar\/state(\?.*)?$/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_STATE) });
  });
  await page.route(/\/api\/calendar\/backlog(\?.*)?$/, (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_BACKLOG) });
    } else {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, item: { id: 'bk_new', title: 'new', status: 'pending' } }),
      });
    }
  });
});

test('renders main sections and dismisses skeleton once data arrives', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}/calendar`);

  await expect(page.locator('h1')).toContainText('Calendar');
  // Section titles are in <div class="section-title">.
  const titles = page.locator('.section-title');
  await expect(titles).toHaveCount(4);
  const titlesText = await titles.allTextContents();
  expect(titlesText).toEqual(['Quick Ask', 'Brief', 'Open Slots Today', 'Backlog']);

  // Skeletons should clear once mocked data resolves.
  await page.waitForFunction(() => document.querySelectorAll('.skeleton').length === 0, null, {
    timeout: 5000,
  });
});

test('back button navigates to home', async ({ page }) => {
  // Navigate to home first so history.back() has somewhere to go.
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}/`);
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}/calendar`);
  await page.locator('.back-btn').click();
  await expect(page).toHaveURL(`http://127.0.0.1:${DASHBOARD_PORT}/`);
});

test('shows error state when backend returns 5xx', async ({ page }) => {
  // Override the default route with a 500.
  await page.unroute(/\/api\/calendar\/state(\?.*)?$/);
  await page.route(/\/api\/calendar\/state(\?.*)?$/, (route) => {
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'simulated failure' }),
    });
  });

  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}/calendar`);

  // The brief content should surface an error/empty/failure indicator.
  await expect
    .poll(async () => (await page.locator('#briefContent').textContent()) || '', {
      timeout: 5000,
      message: 'expected brief container to render error/empty state on 5xx',
    })
    .toMatch(/Error|Failed|No events/i);
});

test('quick ask sends selected provider and opens returned scientist session', async ({ page }) => {
  let seenProvider = '';

  await page.addInitScript(() => {
    window.__openCalls = [];
    const realOpen = window.open.bind(window);
    window.open = (...args) => {
      if (args[0] === 'about:blank') {
        const fakeTab = {
          closed: false,
          document: { title: '' },
          location: {
            replace(url) {
              fakeTab.__lastUrl = url;
            },
          },
          close() {
            fakeTab.closed = true;
          },
          focus() {},
        };
        window.__openCalls.push({ kind: 'placeholder', args, tab: fakeTab });
        return fakeTab;
      }
      window.__openCalls.push({ kind: 'direct', args });
      return realOpen(...args);
    };
  });

  await page.route(/\/api\/agents\/spawn$/, async (route) => {
    const body = route.request().postDataJSON();
    seenProvider = body.provider;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        slotName: 'CalendarPage',
        publicPort: PUBLIC_PORT,
      }),
    });
  });

  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}/calendar`);
  await page.click('#quickAskProviderNext');
  await expect(page.locator('#quickAskProviderHost')).toContainText('Claude');

  await page.fill('#quickAskInput', 'Schedule a planning session for tomorrow afternoon.');
  await page.click('#quickAskButton');

  await expect.poll(async () => {
    return page.evaluate(() => {
      const call = window.__openCalls[0];
      return call && call.tab && call.tab.__lastUrl;
    });
  }, { timeout: 8000 }).toContain(`:${PUBLIC_PORT}`);

  const result = await page.evaluate(() => ({
    providerLabel: document.getElementById('quickAskProviderHost')?.textContent?.trim() || '',
    openCalls: window.__openCalls.map((entry) => ({
      kind: entry.kind,
      args: entry.args,
      lastUrl: entry.tab && entry.tab.__lastUrl ? entry.tab.__lastUrl : '',
      title: entry.tab && entry.tab.document ? entry.tab.document.title : '',
    })),
  }));

  expect(result.providerLabel).toContain('Claude');
  expect(seenProvider).toBe('claude');
  expect(result.openCalls[0]?.kind).toBe('placeholder');
  expect(result.openCalls[0]?.title).toBe('Launching scientist session...');
  expect(result.openCalls[0]?.lastUrl).toContain(`:${PUBLIC_PORT}`);
  expect(result.openCalls[0]?.lastUrl).toContain('atc_connect=');
});

test('dummy test', async ({ page }) => {
  expect(1).toBe(1);
});
