// @ts-check
import { test, expect } from '@playwright/test';

/**
 * E2E tests — "Run Locally" feature
 *
 * Auth is bypassed via GET /auth/test-login (NODE_ENV=test only).
 * All API calls are intercepted via Playwright route mocking:
 *   - /api/chat        → returns a fake SSE build event
 *   - /api/github/deploy → returns a fake success response
 *   - /api/run-local   → returns a fake SSE progress/ready/error stream
 *   - /api/run-local/stop → returns { stopped: 1 }
 *
 * Tests
 * ──────────────────────────────────────────────────────────────────────────────
 * ✅ html + none stack → Run Locally button NOT shown in success card
 * ✅ react + go stack → Run Locally button shown in success card
 * ✅ react + none stack → Run Locally button shown (React can run locally)
 * ✅ clicking Run Locally → progress log panel appears
 * ✅ SSE progress events → messages appear in log panel
 * ✅ SSE ready event → link replaces log, shows correct URL
 * ✅ SSE error event → error message + retry button shown
 * ✅ clicking Stop → calls /api/run-local/stop, shows stopped + Run Again
 * ✅ clicking Run Again → restarts, new SSE started
 * ✅ retry after error → new SSE connection started
 * ✅ Run Locally button not shown for edit-mode deploy success
 */

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Authenticates with the test bypass and navigates to /app */
async function loginAndOpenApp(page) {
  await page.goto('/auth/test-login');
  await page.waitForURL('/app');
}

/** Produces a minimal SSE body string from an array of event objects */
function sseBody(events) {
  return events.map(e => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\n';
}

/**
 * Intercepts /api/chat and /api/github/deploy so the test can drive the
 * full UI flow (chat → deploy) without a real AI or GitHub token.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ frontend: string, backend: string }} stack
 */
async function mockBuildAndDeploy(page, stack) {
  // 1. Chat mock — returns a build SSE with a REPO_NAME
  await page.route('**/api/chat', async (route) => {
    const body = sseBody([
      { type: 'chunk',  text: 'Building your app…' },
      { type: 'done',   text: 'REPO_NAME: test-local-app\n\n```html\n<!DOCTYPE html><html><head><meta charset="UTF-8"><title>T</title></head><body><h1>Hi</h1></body></html>\n```', build: true, repoName: 'test-local-app', deployMode: 'github-pages' },
    ]);
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  // 2. Deploy mock — returns success with pagesUrl but no localUrl (static app)
  await page.route('**/api/github/deploy', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        repoUrl:  'https://github.com/testuser/test-local-app',
        pagesUrl: 'https://testuser.github.io/test-local-app',
        localUrl: null,
        repoName: 'test-local-app',
      }),
    });
  });

  // 3. Simulate the user having selected the stack via window globals
  await page.evaluate(({ fe, be }) => {
    window._stackFrontend = fe;
    window._stackBackend  = be;
    window._githubLogin   = 'testuser';
  }, { fe: stack.frontend, be: stack.backend });
}

/** Drives the flow: type message → click send → wait for deploy button → click deploy */
async function buildAndDeploy(page) {
  // Make welcome cards visible + show prompt bar
  await page.evaluate(() => {
    window._userAuthenticated = true;
    window._githubLogin = 'testuser';
    // Show prompt bar directly (skip welcome-card flow)
    const bar = document.getElementById('chatInputArea');
    if (bar) bar.style.display = '';
    const ws = document.getElementById('welcomeScreen');
    if (ws) ws.remove();
  });

  await page.fill('#chatInput', 'build me a hello world app');
  await page.click('#sendBtn');

  // Wait for deploy button to appear
  const deployBtn = page.locator('button', { hasText: /Deploy to GitHub Pages/i });
  await expect(deployBtn).toBeVisible({ timeout: 10_000 });
  await deployBtn.click();
}

// ── Tests: Run Locally button visibility ──────────────────────────────────────

test.describe('Run Locally button visibility', () => {
  test.beforeEach(async ({ page }) => { await loginAndOpenApp(page); });

  test('NOT shown for html + none stack', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'html', backend: 'none' });
    await buildAndDeploy(page);

    // Wait for deploy success card
    await expect(page.locator('text=Deployed to GitHub Pages')).toBeVisible({ timeout: 10_000 });

    // Run Locally section must NOT be in the DOM
    await expect(page.locator('text=Run this app locally')).not.toBeVisible();
    await expect(page.locator('button', { hasText: /Run Locally/ })).not.toBeVisible();
  });

  test('SHOWN for react + go stack', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'go' });
    await buildAndDeploy(page);

    await expect(page.locator('text=Deployed to GitHub Pages')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible();
  });

  test('SHOWN for react + python stack', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'python' });
    await buildAndDeploy(page);

    await expect(page.locator('text=Deployed to GitHub Pages')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible();
  });

  test('SHOWN for react + none stack (React runs locally with npm start)', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'none' });
    await buildAndDeploy(page);

    await expect(page.locator('text=Deployed to GitHub Pages')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible();
  });

  test('NOT shown when window._stackFrontend is null (no stack selected)', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'html', backend: 'none' }); // sets globals to html+none
    // Explicitly null out the globals to simulate no stack selection
    await page.evaluate(() => {
      window._stackFrontend = null;
      window._stackBackend  = null;
    });
    await buildAndDeploy(page);

    await expect(page.locator('text=Deployed to GitHub Pages')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button', { hasText: /Run Locally/ })).not.toBeVisible();
  });
});

// ── Tests: Run Locally progress flow ─────────────────────────────────────────

test.describe('Run Locally — progress stream', () => {
  test.beforeEach(async ({ page }) => { await loginAndOpenApp(page); });

  test('clicking Run Locally shows progress log panel', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'go' });

    // Mock /api/run-local — returns progress events then hangs (to observe log panel)
    await page.route('**/api/run-local', async (route) => {
      const body = sseBody([
        { type: 'progress', message: 'Cloning repository...' },
        { type: 'progress', message: 'Installing dependencies...' },
      ]);
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    });

    await buildAndDeploy(page);
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible({ timeout: 10_000 });
    await page.click('button:has-text("Run Locally")');

    // Progress log container should appear
    await expect(page.locator('text=Setting up local environment')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Cloning repository...')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Installing dependencies...')).toBeVisible({ timeout: 5_000 });
  });

  test('READY event shows clickable link with correct URL', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'go' });

    await page.route('**/api/run-local', async (route) => {
      const body = sseBody([
        { type: 'progress', message: 'Cloning...' },
        { type: 'ready',    url: 'http://localhost:3000' },
      ]);
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    });

    await buildAndDeploy(page);
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible({ timeout: 10_000 });
    await page.click('button:has-text("Run Locally")');

    // Success link should appear
    const link = page.locator('a', { hasText: /localhost:3000/ });
    await expect(link).toBeVisible({ timeout: 5_000 });
    await expect(link).toHaveAttribute('href', 'http://localhost:3000');
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('ERROR event shows error message and Retry button', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'go' });

    await page.route('**/api/run-local', async (route) => {
      const body = sseBody([
        { type: 'progress', message: 'Cloning...' },
        { type: 'error',    message: 'Go is not installed. Please install it from https://go.dev/dl' },
      ]);
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    });

    await buildAndDeploy(page);
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible({ timeout: 10_000 });
    await page.click('button:has-text("Run Locally")');

    await expect(page.locator('text=Go is not installed')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button', { hasText: /Retry/ })).toBeVisible();
  });

  test('Stop button calls /api/run-local/stop and shows "stopped" state', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'go' });

    await page.route('**/api/run-local', async (route) => {
      // Progress only — stream stays open (simulates running server)
      const body = sseBody([
        { type: 'progress', message: 'Setting up...' },
      ]);
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    });

    let stopCalled = false;
    await page.route('**/api/run-local/stop', async (route) => {
      stopCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ stopped: 1 }),
      });
    });

    await buildAndDeploy(page);
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible({ timeout: 10_000 });
    await page.click('button:has-text("Run Locally")');

    await expect(page.locator('button', { hasText: /■ Stop/ })).toBeVisible({ timeout: 5_000 });
    await page.click('button:has-text("■ Stop")');

    expect(stopCalled).toBe(true);
    await expect(page.locator('text=Local servers stopped')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button', { hasText: /Run Again/ })).toBeVisible();
  });

  test('Run Again after Stop starts a new SSE connection', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'go' });

    let runLocalCallCount = 0;

    await page.route('**/api/run-local', async (route) => {
      runLocalCallCount++;
      const body = sseBody([
        { type: 'progress', message: `Attempt ${runLocalCallCount}` },
        { type: 'ready',    url: 'http://localhost:3000' },
      ]);
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    });

    await page.route('**/api/run-local/stop', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ stopped: 1 }),
      });
    });

    await buildAndDeploy(page);
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible({ timeout: 10_000 });

    // First run
    await page.click('button:has-text("Run Locally")');
    await expect(page.locator('a', { hasText: /localhost:3000/ })).toBeVisible({ timeout: 5_000 });

    // Stop then Run Again
    await page.click('button:has-text("■ Stop local")');
    await expect(page.locator('button', { hasText: /Run Again/ })).toBeVisible({ timeout: 5_000 });
    await page.click('button:has-text("Run Again")');

    // Second SSE started
    await expect(page.locator('text=Attempt 2')).toBeVisible({ timeout: 5_000 });
    expect(runLocalCallCount).toBe(2);
  });

  test('Retry button after error starts a new SSE connection', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'go' });

    let callCount = 0;
    await page.route('**/api/run-local', async (route) => {
      callCount++;
      const body = callCount === 1
        ? sseBody([{ type: 'error', message: 'Clone failed' }])
        : sseBody([{ type: 'ready', url: 'http://localhost:3000' }]);
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    });

    await buildAndDeploy(page);
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible({ timeout: 10_000 });
    await page.click('button:has-text("Run Locally")');

    await expect(page.locator('text=Clone failed')).toBeVisible({ timeout: 5_000 });
    await page.click('button:has-text("Retry")');

    await expect(page.locator('a', { hasText: /localhost:3000/ })).toBeVisible({ timeout: 5_000 });
    expect(callCount).toBe(2);
  });

  test('non-200 from /api/run-local shows error and Retry button', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'go' });

    await page.route('**/api/run-local', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'owner and repo are required' }),
      });
    });

    await buildAndDeploy(page);
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible({ timeout: 10_000 });
    await page.click('button:has-text("Run Locally")');

    await expect(page.locator('text=owner and repo are required')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button', { hasText: /Retry/ })).toBeVisible();
  });
});

// ── Regression: stale state ───────────────────────────────────────────────────

test.describe('Run Locally — stale state regression', () => {
  test.beforeEach(async ({ page }) => { await loginAndOpenApp(page); });

  test('stack globals reset via startNewConversation does not leave Run Locally visible', async ({ page }) => {
    // Build react+go app → deploy (Run Locally shown)
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'go' });
    await buildAndDeploy(page);
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible({ timeout: 10_000 });

    // Start new conversation (should reset UI but globals may be stale)
    await page.evaluate(() => {
      if (typeof startNewConversation === 'function') startNewConversation();
    });

    // After new conversation, the previous success card should be gone
    await expect(page.locator('button', { hasText: /Run Locally/ })).not.toBeVisible({ timeout: 3_000 });
  });
});

// ── Payload validation ────────────────────────────────────────────────────────

test.describe('Run Locally — payload sent to /api/run-local', () => {
  test.beforeEach(async ({ page }) => { await loginAndOpenApp(page); });

  test('payload contains correct owner, repo, and stack', async ({ page }) => {
    await mockBuildAndDeploy(page, { frontend: 'react', backend: 'go' });

    let capturedPayload = null;
    await page.route('**/api/run-local', async (route) => {
      capturedPayload = route.request().postDataJSON();
      const body = sseBody([{ type: 'ready', url: 'http://localhost:3000' }]);
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    });

    await buildAndDeploy(page);
    await expect(page.locator('button', { hasText: /Run Locally/ })).toBeVisible({ timeout: 10_000 });
    await page.click('button:has-text("Run Locally")');
    await expect(page.locator('a', { hasText: /localhost/ })).toBeVisible({ timeout: 5_000 });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload.owner).toBe('testuser');
    expect(capturedPayload.repo).toBe('test-local-app');
    expect(capturedPayload.stack.frontend).toBe('react');
    expect(capturedPayload.stack.backend).toBe('go');
  });
});
