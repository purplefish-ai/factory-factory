import { defineConfig } from 'vitest/config';
import config from './vitest.config';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    coverage: {
      ...config.test.coverage,
      // Partial shards cannot satisfy whole-suite coverage thresholds. The Test
      // job merges their blob reports using vitest.config.ts and enforces both
      // the global thresholds and check:coverage:critical exactly once.
      thresholds: undefined,
      reporter: [],
    },
  },
});
