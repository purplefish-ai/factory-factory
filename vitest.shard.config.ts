import { defineConfig } from 'vitest/config';
import CoverageSequencer from './scripts/coverage-sequencer';
import config from './vitest.config';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    sequence: { sequencer: CoverageSequencer },
    reporters: ['default', 'blob', './scripts/coverage-timing-reporter.ts'],
    coverage: {
      ...config.test.coverage,
      // Partial shards cannot satisfy whole-suite coverage thresholds. The Test
      // job merges their blob reports using the shared coverage policy and enforces both
      // the global thresholds and check:coverage:critical exactly once.
      thresholds: undefined,
      reporter: [],
    },
  },
});
