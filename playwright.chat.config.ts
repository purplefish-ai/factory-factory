import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'scroll-button-occlusion.spec.ts',
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://127.0.0.1:6194',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec storybook dev --ci --host 127.0.0.1 --port 6194',
    url: 'http://127.0.0.1:6194',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
