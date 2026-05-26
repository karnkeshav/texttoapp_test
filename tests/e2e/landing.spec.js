// @ts-check
import { test, expect } from '@playwright/test';

/**
 * Landing page (public, no auth required) E2E tests.
 */
test.describe('Landing page', () => {
  test('loads with a 200 status', async ({ page }) => {
    const response = await page.goto('/');
    expect(response.status()).toBe(200);
  });

  test('has correct title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Ready4Launch/i);
  });

  test('shows a "Sign in with GitHub" button', async ({ page }) => {
    await page.goto('/');
    // Look for a link/button pointing to the GitHub OAuth route
    const githubBtn = page.locator('a[href="/auth/github"]');
    await expect(githubBtn).toBeVisible();
  });

  test('unauthenticated visit to /app redirects away', async ({ page }) => {
    await page.goto('/app');
    // Should redirect to / (not /app) because the session is not authenticated
    await expect(page).not.toHaveURL(/\/app$/);
  });

  test('/auth/status returns authenticated:false for new session', async ({ request }) => {
    const res = await request.get('/auth/status');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.authenticated).toBe(false);
  });
});
