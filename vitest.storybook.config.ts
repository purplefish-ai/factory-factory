import path from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Renders every Storybook story in headless Chromium and runs its play function
// (`pnpm test:storybook`). Kept apart from vitest.config.ts so `pnpm test` never
// needs a browser. See docs/storybook.md#story-tests.
export default defineConfig({
  plugins: [
    storybookTest({
      configDir: path.join(import.meta.dirname, '.storybook'),
      storybookScript: 'pnpm storybook --no-open',
      // Stories tagged `test-skip` are reported as skipped. Each one needs a
      // comment pointing at the issue that tracks it.
      tags: { skip: ['test-skip'] },
    }),
  ],
  test: {
    name: 'storybook',
    setupFiles: ['./.storybook/vitest.setup.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
  },
});
