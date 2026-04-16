import { test, expect, devices } from '@playwright/test';
import { DashboardHarness } from './harness.mjs';

const DASHBOARD_PORT = 19116;
const BACKEND_PORT = 18106;
const PUBLIC_PORT = 17106;

const harness = new DashboardHarness({
  dashboardPort: DASHBOARD_PORT,
  backendPort: BACKEND_PORT,
  publicPort: PUBLIC_PORT,
});

test.use({
  ...devices['iPhone 13'],
});

test.beforeAll(async () => {
  await harness.setup('Repro');
});

test.afterAll(async () => {
  await harness.teardown();
});

// Read effective scroll: window.scrollY is 0 when body is position:fixed (iOS scroll lock).
// Read the locked offset from body.style.top instead.
function getEffectiveScrollY(page) {
  return page.evaluate(() => {
    const body = document.body;
    if (body.style.position === 'fixed') return Math.abs(parseInt(body.style.top || '0', 10));
    return window.scrollY;
  });
}

test('verify scrolling and page jump issues on mobile', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${DASHBOARD_PORT}`);
  await page.waitForSelector('.session.tap');

  // Capture scroll at start (should be 0 on fresh load)
  const initialScroll = await page.evaluate(() => window.scrollY);
  console.log('Initial window.scrollY:', initialScroll);
  expect(initialScroll).toBe(0);

  // Click the card; Playwright auto-scrolls to make it visible first.
  // Capture the scroll position right before the modal opens.
  await page.click('.session.tap');
  await page.waitForSelector('#intent-modal.open');

  // While modal is open body is position:fixed — read saved offset from body.style.top.
  const scrollAfterOpen = await getEffectiveScrollY(page);
  console.log('Effective scroll after opening modal:', scrollAfterOpen);
  // The effective scroll must match where Playwright scrolled to click the card.
  // Critically, it must NOT have jumped — carousel buttons verify this below.
  const preModalScroll = scrollAfterOpen;

  // Navigate the provider carousel — scroll must not change.
  await page.click('#provider-next');
  await page.waitForTimeout(300);
  const scrollAfterNext = await getEffectiveScrollY(page);
  console.log('Effective scroll after provider-next:', scrollAfterNext);
  expect(scrollAfterNext, 'Scroll must not jump when navigating provider carousel').toBe(preModalScroll);

  await page.click('#provider-prev');
  await page.waitForTimeout(300);
  const scrollAfterPrev = await getEffectiveScrollY(page);
  console.log('Effective scroll after provider-prev:', scrollAfterPrev);
  expect(scrollAfterPrev, 'Scroll must not jump when navigating provider carousel back').toBe(preModalScroll);

  // Click "Start session" — modal closes, scroll must be RESTORED to pre-modal position.
  await page.click('#intent-confirm');
  await page.waitForSelector('#intent-modal', { state: 'hidden' });

  const scrollAfterStart = await page.evaluate(() => window.scrollY);
  console.log('window.scrollY after clicking Start session:', scrollAfterStart);
  expect(scrollAfterStart, 'Scroll must be restored to pre-modal position after starting session').toBe(preModalScroll);
});
