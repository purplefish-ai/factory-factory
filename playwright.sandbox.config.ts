import { defineConfig } from '@playwright/test';

// The real application in `pnpm dev:sandbox`, which the global setup starts and stops; the
// scripted Codex provider stands in for the agent. No credentials and no external service.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'sandbox-smoke.spec.ts',
  outputDir: 'test-results/sandbox',
  globalSetup: './e2e/sandbox-smoke.setup.ts',
  workers: 1,
  // A failure here is a defect to investigate, never a retry.
  retries: 0,
  // Sized for a machine at load 100 or more; each wait in the spec has its own timeout.
  timeout: 600_000,
  use: {
    // A click or fill that cannot find its target fails with a locator error after this long, not
    // at the test timeout. Generous (the page can take many seconds to respond at load 100 or
    // more), yet a tenth of the test timeout.
    actionTimeout: 60_000,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
