import { defineConfig } from 'vitest/config';
import config from './vitest.config.ts';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    // This command runs only backend integration tests, not the root projects.
    projects: undefined,
    include: ['src/backend/**/*.integration.test.ts'],
  },
});
