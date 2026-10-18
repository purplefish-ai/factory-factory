import { defineConfig } from 'vitest/config';
import base from '../vitest.config';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['scripts/bench-subagent-transcript.ts'],
    setupFiles: [],
    disableConsoleIntercept: true,
    testTimeout: 60_000,
    env: { NODE_ENV: 'production' },
  },
});
