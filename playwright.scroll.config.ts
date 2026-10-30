import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results/transcript-scroll',
  testMatch: 'transcript-scroll.spec.ts',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5194',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1100, height: 800 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 375, height: 667 } } },
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5194',
    url: 'http://127.0.0.1:5194',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
