import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'workspace-creation-draft-storage.spec.ts',
  outputDir: 'test-results/workspace-drafts',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5195',
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5195',
    url: 'http://127.0.0.1:5195',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
