// @ts-check
import { test, expect } from '@playwright/test';

/**
 * App interface E2E tests.
 *
 * Auth is bypassed via GET /auth/test-login (only available when NODE_ENV=test).
 * AI responses are mocked via Playwright's route interception — no API quota used.
 */

const STYLE_QUESTION = 'One quick thing before I build — what vibe? 🎨 Dark & Sleek (black/purple), ☀️ Light & Clean (white/blue), or describe your own style!';

const MINIMAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Counter App</title>
  <style>body { margin: 0; background: #09090f; color: #f1f5f9; display:flex; align-items:center; justify-content:center; min-height:100vh; }</style>
</head>
<body>
  <div id="app">
    <h1>Counter</h1>
    <button id="btn">Count: 0</button>
  </div>
  <script>
    var count = 0;
    document.getElementById('btn').addEventListener('click', function() {
      count++;
      document.getElementById('btn').textContent = 'Count: ' + count;
    });
  </script>
</body>
</html>`;

/** Build a mock SSE response body from an array of events. */
function sseBody(events) {
  return events.map(e => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\n';
}

/** Log in using the test bypass route (NODE_ENV=test only). */
async function testLogin(page) {
  const res = await page.goto('/auth/test-login');
  expect(res.status()).toBe(200);
}

// ── Auth bypass ───────────────────────────────────────────────────────────────

test.describe('Test auth bypass (NODE_ENV=test)', () => {
  test('/auth/test-login sets session and returns ok', async ({ page }) => {
    await testLogin(page);
    const body = await page.locator('body').textContent();
    expect(body).toContain('"ok":true');
  });

  test('authenticated session allows access to /app', async ({ page }) => {
    await testLogin(page);
    await page.goto('/app');
    await expect(page).toHaveURL('/app');
    // Should not redirect away
    await expect(page.locator('#chatMessages')).toBeVisible();
  });
});

// ── App interface basics ──────────────────────────────────────────────────────

test.describe('App interface', () => {
  test.beforeEach(async ({ page }) => {
    await testLogin(page);
    await page.goto('/app');
  });

  test('shows the welcome screen on first load', async ({ page }) => {
    await expect(page.locator('.welcome-screen')).toBeVisible();
    await expect(page.locator('.welcome-title')).toContainText('What do you want to build');
  });

  test('shows the user name in the sidebar', async ({ page }) => {
    await expect(page.locator('#userName')).toBeVisible();
    await expect(page.locator('#userName')).toContainText('Test User');
  });

  test('chat input is visible and enabled', async ({ page }) => {
    await expect(page.locator('#chatInput')).toBeVisible();
    await expect(page.locator('#chatInput')).toBeEnabled();
  });

  test('send button is visible and enabled', async ({ page }) => {
    await expect(page.locator('#sendBtn')).toBeVisible();
    await expect(page.locator('#sendBtn')).toBeEnabled();
  });

  test('pressing Enter submits the message', async ({ page }) => {
    // Mock the chat API so we don't hit Gemini
    await page.route('/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'chunk', text: STYLE_QUESTION },
          { type: 'done',  text: STYLE_QUESTION },
        ]),
      });
    });

    await page.locator('#chatInput').fill('build me a counter');
    await page.locator('#chatInput').press('Enter');

    // User message bubble should appear
    await expect(page.locator('.message.user .msg-bubble')).toContainText('build me a counter');
  });
});

// ── Chat flow — style question ────────────────────────────────────────────────

test.describe('Chat — style question flow', () => {
  test.beforeEach(async ({ page }) => {
    await testLogin(page);
    await page.goto('/app');
  });

  test('welcome screen disappears after first message', async ({ page }) => {
    await page.route('/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'chunk', text: STYLE_QUESTION },
          { type: 'done',  text: STYLE_QUESTION },
        ]),
      });
    });

    await page.locator('#chatInput').fill('build me a todo app');
    await page.click('#sendBtn');

    await expect(page.locator('.welcome-screen')).not.toBeVisible();
  });

  test('AI response appears in the chat', async ({ page }) => {
    await page.route('/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'chunk', text: STYLE_QUESTION },
          { type: 'done',  text: STYLE_QUESTION },
        ]),
      });
    });

    await page.locator('#chatInput').fill('build me a todo app');
    await page.click('#sendBtn');

    const aiMsg = page.locator('.message.ai .msg-bubble').last();
    await expect(aiMsg).toContainText('One quick thing', { timeout: 8000 });
  });

  test('send button is disabled during streaming', async ({ page }) => {
    let resolveMock;
    const mockDone = new Promise(resolve => { resolveMock = resolve; });

    await page.route('/api/chat', async (route) => {
      // Hold the response until we check the button state
      await mockDone;
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'done', text: 'ok' },
        ]),
      });
    });

    await page.locator('#chatInput').fill('test message');
    await page.click('#sendBtn');

    // Button should be disabled while waiting for response
    await expect(page.locator('#sendBtn')).toBeDisabled();

    // Release the mock
    resolveMock();
    await expect(page.locator('#sendBtn')).toBeEnabled({ timeout: 5000 });
  });
});

// ── Deploy button flow ────────────────────────────────────────────────────────

test.describe('Deploy button', () => {
  test.beforeEach(async ({ page }) => {
    await testLogin(page);
    await page.goto('/app');
  });

  test('deploy button appears when AI returns REPO_NAME + html block', async ({ page }) => {
    const fullResponse = `REPO_NAME: counter-app\n\nHere is your counter app:\n\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;

    await page.route('/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'status', message: 'Thinking…' },
          { type: 'chunk',  text: fullResponse },
          { type: 'done',   text: fullResponse },
        ]),
      });
    });

    await page.locator('#chatInput').fill('build me a counter app');
    await page.click('#sendBtn');

    const deployBtn = page.locator('button', { hasText: 'Deploy to GitHub Pages' });
    await expect(deployBtn).toBeVisible({ timeout: 10_000 });
  });

  test('deploy button does NOT appear for a style question (no code)', async ({ page }) => {
    await page.route('/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'chunk', text: STYLE_QUESTION },
          { type: 'done',  text: STYLE_QUESTION },
        ]),
      });
    });

    await page.locator('#chatInput').fill('build me an app');
    await page.click('#sendBtn');

    // Wait for AI response to render
    await expect(page.locator('.message.ai .msg-bubble').last()).toBeVisible({ timeout: 8000 });

    // Deploy button should NOT be visible
    const deployBtn = page.locator('button', { hasText: 'Deploy to GitHub Pages' });
    await expect(deployBtn).not.toBeVisible();
  });

  test('deploy button appears even when response is truncated (no closing ```)', async ({ page }) => {
    // This was the Bug #2 — truncated HTML block had no closing ```
    // checkForCode fallback regex should handle it
    const truncatedResponse = `REPO_NAME: counter-app\n\nHere is your counter app:\n\n\`\`\`html\n${MINIMAL_HTML}`;
    // Note: no closing ```

    await page.route('/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'chunk', text: truncatedResponse },
          { type: 'done',  text: truncatedResponse },
        ]),
      });
    });

    await page.locator('#chatInput').fill('build me a counter');
    await page.click('#sendBtn');

    const deployBtn = page.locator('button', { hasText: 'Deploy to GitHub Pages' });
    await expect(deployBtn).toBeVisible({ timeout: 10_000 });
  });

  test('deploy button shows correct repo name', async ({ page }) => {
    const fullResponse = `REPO_NAME: my-portfolio-site\n\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;

    await page.route('/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'chunk', text: fullResponse },
          { type: 'done',  text: fullResponse },
        ]),
      });
    });

    await page.locator('#chatInput').fill('build a portfolio');
    await page.click('#sendBtn');

    // The deploy card should mention the repo name inside the purple card
    // (use the card container to avoid matching the repo name also present in the chat bubble)
    const deployCard = page.locator('div').filter({ hasText: 'Deploy to GitHub Pages' }).first();
    await expect(deployCard).toBeVisible({ timeout: 10_000 });
    await expect(deployCard).toContainText('my-portfolio-site');
  });

  test('clicking deploy button calls /api/github/deploy and shows success', async ({ page }) => {
    const fullResponse = `REPO_NAME: counter-app\n\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;

    await page.route('/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'chunk', text: fullResponse },
          { type: 'done',  text: fullResponse },
        ]),
      });
    });

    // Mock the deploy endpoint
    await page.route('/api/github/deploy', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          pagesUrl: 'https://testuser.github.io/counter-app',
          repoUrl:  'https://github.com/testuser/counter-app',
        }),
      });
    });

    await page.locator('#chatInput').fill('build me a counter app');
    await page.click('#sendBtn');

    const deployBtn = page.locator('button', { hasText: 'Deploy to GitHub Pages' });
    await expect(deployBtn).toBeVisible({ timeout: 10_000 });
    await deployBtn.click();

    // Success state should show the live URL
    const liveUrl = page.locator('text=testuser.github.io/counter-app');
    await expect(liveUrl).toBeVisible({ timeout: 8_000 });
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

test.describe('Error handling', () => {
  test.beforeEach(async ({ page }) => {
    await testLogin(page);
    await page.goto('/app');
  });

  test('shows error message when server returns error event', async ({ page }) => {
    await page.route('/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'error', message: 'Ready4Launch ran into an issue. Please try again.' },
        ]),
      });
    });

    await page.locator('#chatInput').fill('test');
    await page.click('#sendBtn');

    const aiMsg = page.locator('.message.ai .msg-bubble').last();
    await expect(aiMsg).toContainText('⚠️', { timeout: 8000 });
  });

  test('shows warning when server returns 500', async ({ page }) => {
    await page.route('/api/chat', async (route) => {
      await route.fulfill({ status: 500 });
    });

    await page.locator('#chatInput').fill('test');
    await page.click('#sendBtn');

    const aiMsg = page.locator('.message.ai .msg-bubble').last();
    await expect(aiMsg).toContainText('⚠️', { timeout: 8000 });
  });

  test('send button re-enables after error', async ({ page }) => {
    await page.route('/api/chat', async (route) => {
      await route.fulfill({ status: 500 });
    });

    await page.locator('#chatInput').fill('test');
    await page.click('#sendBtn');

    await expect(page.locator('#sendBtn')).toBeEnabled({ timeout: 8000 });
  });
});

// ── New conversation ──────────────────────────────────────────────────────────

test.describe('New conversation', () => {
  test.beforeEach(async ({ page }) => {
    await testLogin(page);
    await page.goto('/app');
  });

  test('clicking "New conversation" resets the chat UI', async ({ page }) => {
    await page.route('/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody([
          { type: 'chunk', text: STYLE_QUESTION },
          { type: 'done',  text: STYLE_QUESTION },
        ]),
      });
    });

    // Send a message
    await page.locator('#chatInput').fill('build me an app');
    await page.click('#sendBtn');
    await expect(page.locator('.message.user')).toBeVisible({ timeout: 8000 });

    // On desktop the sidebar is always visible — click "New conversation" directly.
    // (The .sidebar-toggle hamburger is only shown on mobile viewports.)
    await page.click('button:has-text("New conversation")');

    // Welcome screen should reappear
    await expect(page.locator('.welcome-screen')).toBeVisible();
    // Previous messages should be gone
    await expect(page.locator('.message.user')).not.toBeVisible();
  });
});
