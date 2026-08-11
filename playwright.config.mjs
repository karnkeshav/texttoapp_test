import { defineConfig, devices } from '@playwright/test';
import { config as dotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv({ path: resolve(__dirname, '.env') });

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  // Playwright starts a dedicated test server on port 3001.
  // NODE_ENV=test enables the /auth/test-login bypass route.
  // This keeps the dev server (port 3000) running alongside tests.
  webServer: {
    command: 'node server/index.js',
    url: 'http://localhost:3001',
    reuseExistingServer: false,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '3001',
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
