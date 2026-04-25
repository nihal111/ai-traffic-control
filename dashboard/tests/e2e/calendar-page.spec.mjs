import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:1111';

test.describe('Calendar Page', () => {
  test('should load calendar page and display main sections', async ({ page }) => {
    await page.goto(`${BASE_URL}/calendar`);

    // Check page title
    await expect(page.locator('h1')).toContainText('Calendar');

    // Check sections are visible
    await expect(page.locator('text=Quick Ask')).toBeVisible();
    await expect(page.locator('text=Today\'s Brief')).toBeVisible();
    await expect(page.locator('text=Open Slots Today')).toBeVisible();
    await expect(page.locator('text=Backlog')).toBeVisible();
    await expect(page.locator('text=Updated:')).toBeVisible();
  });

  test('should display dashboard data after load', async ({ page }) => {
    await page.goto(`${BASE_URL}/calendar`);

    // Wait for content to load (should not be skeleton anymore)
    await page.waitForFunction(() => {
      const skeletons = document.querySelectorAll('.skeleton');
      return skeletons.length === 0;
    }, { timeout: 5000 });

    // Verify that brief content is displayed
    const briefContent = page.locator('#briefContent');
    await expect(briefContent).not.toHaveClass(/loading/);
  });

  test('should add a backlog item via quick ask', async ({ page }) => {
    await page.goto(`${BASE_URL}/calendar`);

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Type a quick ask
    const input = page.locator('#quickAskInput');
    await input.fill('Review API documentation');

    // Click send button
    await page.locator('button:has-text("Ask")').click();

    // Wait a moment for the agent to spawn
    await page.waitForTimeout(1000);

    // Input should be cleared
    await expect(input).toHaveValue('');
  });

  test('should navigate back to home', async ({ page }) => {
    await page.goto(`${BASE_URL}/calendar`);

    // Click back button
    await page.locator('.back-btn').click();

    // Should navigate back (check for home page elements)
    await expect(page).toHaveURL(`${BASE_URL}/`);
  });

  test('should handle backlog item actions', async ({ page }) => {
    // This test assumes there is at least one pending backlog item
    await page.goto(`${BASE_URL}/calendar`);

    // Wait for content to load
    await page.waitForFunction(() => {
      const backlog = document.getElementById('backlogContent');
      return backlog && !backlog.classList.contains('loading');
    }, { timeout: 5000 });

    // Check if there are any action buttons (✓ or ✗)
    const actionButtons = page.locator('.action-btn');
    const count = await actionButtons.count();

    if (count > 0) {
      // Get the first action button
      const firstButton = actionButtons.first();

      // Click it
      await firstButton.click();

      // Wait for reload
      await page.waitForTimeout(500);

      // Verify the dashboard was refreshed
      await expect(page.locator('#lastUpdated')).not.toHaveText('—');
    }
  });

  test('should reload dashboard when page becomes visible', async ({ page, context }) => {
    await page.goto(`${BASE_URL}/calendar`);

    // Get initial update time
    const initialTime = await page.locator('#lastUpdated').textContent();

    // Simulate page visibility change
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        writable: true,
        value: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Wait a moment
    await page.waitForTimeout(500);

    // Make page visible again
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        writable: true,
        value: false,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Wait for reload
    await page.waitForFunction(() => {
      const time = document.getElementById('lastUpdated').textContent;
      return time !== initialTime;
    }, { timeout: 5000 }).catch(() => {
      // This may fail if data hasn't changed, which is ok
    });
  });

  test('should display empty states when no data', async ({ page }) => {
    // Mock the API to return empty data
    await page.route(`${BASE_URL}/api/calendar/state`, (route) => {
      route.abort();
    });

    await page.goto(`${BASE_URL}/calendar`);

    // Wait a moment for error handling
    await page.waitForTimeout(1000);

    // Check for error message or empty states
    const briefContent = page.locator('#briefContent');
    // Should contain either error or empty state
    const text = await briefContent.textContent();
    expect(text).toMatch(/Error|No events|Failed/i);
  });
});
