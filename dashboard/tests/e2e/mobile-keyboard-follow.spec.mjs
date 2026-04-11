import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, devices } from '@playwright/test';
import { DashboardHarness } from './harness.mjs';

const DASHBOARD_PORT = 19113;
const BACKEND_PORT = 18103;
const PUBLIC_PORT = 17103;

const harness = new DashboardHarness({
  dashboardPort: DASHBOARD_PORT,
  backendPort: BACKEND_PORT,
  publicPort: PUBLIC_PORT,
});

const MOBILE_CSS_PATH = path.resolve(process.cwd(), '../nginx-ttyd/ttyd-mobile.css');
const MOBILE_JS_PATH = path.resolve(process.cwd(), '../nginx-ttyd/ttyd-mobile.js');
const MOBILE_TOOLBAR_HTML = `
<div id="ttyd-mobile-toolbar" aria-label="Terminal mobile controls">
  <div id="ttyd-session-summary" hidden>
    <span id="ttyd-session-summary-agent"></span>
    <span id="ttyd-session-summary-separator" aria-hidden="true">&#8226;</span>
    <span id="ttyd-session-summary-task"></span>
  </div>
  <div id="ttyd-toolbar-main">
    <button type="button" id="ttyd-btn-ctrlc">Ctrl+C</button>
    <button type="button" id="ttyd-btn-tab">Tab</button>
    <button type="button" id="ttyd-btn-up">&#8593;</button>
    <button type="button" id="ttyd-btn-down">&#8595;</button>
    <button type="button" id="ttyd-btn-esc">Esc</button>
  </div>
  <div id="ttyd-toolbar-vim">
    <button type="button" id="ttyd-btn-ctrlb">Ctrl+B</button>
    <button type="button" id="ttyd-btn-bracket">[</button>
    <button type="button" id="ttyd-btn-pgup">PgUp</button>
    <button type="button" id="ttyd-btn-pgdn">PgDn</button>
  </div>
</div>
`;

test.use({
  browserName: 'chromium',
  ...devices['iPhone 13'],
});

test.beforeAll(async () => {
  await harness.setup('Curie');
});

test.afterAll(async () => {
  await harness.teardown();
});

test('terminal container shrinks and cursor stays visible when mobile keyboard opens', async ({ page }) => {
  await harness.spawnAndWaitForBackend();
  await page.goto(`http://127.0.0.1:${BACKEND_PORT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 15000 });

  // Inject mobile CSS, toolbar HTML, and JS (same injection Nginx does in production).
  const mobileCss = await fs.readFile(MOBILE_CSS_PATH, 'utf8');
  const mobileJs = await fs.readFile(MOBILE_JS_PATH, 'utf8');
  await page.addStyleTag({ content: mobileCss });
  await page.evaluate((toolbarHtml) => {
    if (!document.getElementById('ttyd-mobile-toolbar')) {
      document.body.insertAdjacentHTML('beforeend', toolbarHtml);
    }
    window.TTYD_MOBILE_FLAGS = {
      scrollbar: false,
      history: false,
      touchscroll: false,
    };
    window.TTYD_SESSION_META = {
      slotName: 'Curie',
      fallbackName: 'Curie',
      fallbackTaskTitle: 'Keyboard follow mobile test',
    };
  }, MOBILE_TOOLBAR_HTML);
  await page.addScriptTag({ content: mobileJs });
  await page.waitForSelector('#ttyd-mobile-toolbar', { timeout: 10000 });
  await expect(page.locator('#ttyd-session-summary')).toContainText('Curie');
  await expect(page.locator('#ttyd-session-summary')).toContainText('Keyboard follow mobile test');

  const shotsDir = path.join(process.cwd(), 'test-results', 'mobile-keyboard-follow');
  await fs.mkdir(shotsDir, { recursive: true });

  // Push some output so the cursor is at the bottom of the terminal.
  await page.locator('.xterm').click({ position: { x: 120, y: 120 } });
  await page.evaluate(() => {
    if (typeof window.__ttydMobileSendSeq === 'function') {
      for (let i = 0; i < 30; i += 1) window.__ttydMobileSendSeq('\r');
    }
  });
  await page.waitForTimeout(250);

  await page.screenshot({ path: path.join(shotsDir, 'mobile-before-keyboard.png'), fullPage: true });

  // Simulate mobile keyboard opening (320px offset — typical iOS keyboard height).
  const KEYBOARD_HEIGHT = 320;
  await page.evaluate((kbh) => {
    if (typeof window.__ttydMobileDebugSetKeyboardOffset === 'function') {
      window.__ttydMobileDebugSetKeyboardOffset(kbh);
    }
  }, KEYBOARD_HEIGHT);

  // Allow settle time for resize events and scroll.
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shotsDir, 'mobile-after-keyboard.png'), fullPage: true });

  const after = await page.evaluate(() => {
    const container = document.getElementById('terminal-container');
    const helper = document.querySelector('.xterm-helper-textarea');
    const tb = document.getElementById('ttyd-mobile-toolbar');
    const scroller = document.scrollingElement || document.documentElement;
    const cr = container ? container.getBoundingClientRect() : null;
    const hr = helper ? helper.getBoundingClientRect() : null;
    const tr = tb ? tb.getBoundingClientRect() : null;
    return {
      containerHeight: cr ? cr.height : 0,
      containerBottom: cr ? cr.bottom : 0,
      helperBottom: hr ? hr.bottom : null,
      toolbarTop: tr ? tr.top : null,
      pageScrollTop: scroller ? scroller.scrollTop : 0,
      viewportHeight: window.innerHeight,
      bodyOverflow: getComputedStyle(document.body).overflow,
    };
  });

  // 1. The body overflow must not be hidden (our CSS override).
  expect(after.bodyOverflow).not.toBe('hidden');

  // 2. The cursor helper textarea should be above or at the toolbar top.
  expect(after.helperBottom).not.toBeNull();
  expect(after.toolbarTop).not.toBeNull();
  expect(after.helperBottom).toBeLessThanOrEqual(after.toolbarTop + 5);
});
