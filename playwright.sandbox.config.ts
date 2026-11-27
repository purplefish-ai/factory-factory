import { defineConfig } from '@playwright/test';

// The restart and crash specs, which kill, stop or crash the backend. CI runs this project and
// `general` (every other spec, new files included) as parallel shards, each with its own sandbox.
const restartSpecs = /(?:^|[\\/])(?:restart-[^\\/]*|crash-points)\.spec\.ts$/;

// The real application in `pnpm dev:sandbox`, which the global setup starts once and stops; the
// scripted Codex provider stands in for the agent. No credentials and no external service. Each
// file in e2e/sandbox/ is one scenario, and every one of them in the run (both projects locally,
// one with `--project`) runs against that one sandbox. The shards are a CI split: two runs at
// once in one checkout get separate sandboxes but share test-results/.
export default defineConfig({
  testDir: './e2e/sandbox',
  testMatch: '*.spec.ts',
  outputDir: 'test-results/sandbox',
  globalSetup: './e2e/sandbox/global-setup.ts',
  projects: [
    { name: 'general', testIgnore: restartSpecs },
    { name: 'restart', testMatch: restartSpecs },
  ],
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
