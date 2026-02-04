import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 120_000, // 2 minutes - Claude can be slow
    hookTimeout: 60_000, // 1 minute for setup/teardown
    pool: 'forks', // Process isolation
    poolOptions: {
      forks: {
        singleFork: true, // Run sequentially (no parallel Claude sessions)
      },
    },
    retry: 2, // Retry failed tests up to 2 times for flakiness
    setupFiles: ['./src/backend/testing/integration/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@prisma-gen': path.resolve(__dirname, './prisma/generated'),
    },
  },
});
