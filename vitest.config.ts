import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', '.next'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      include: ['src/backend/**/*.ts'],
      exclude: ['src/backend/**/*.test.ts', 'src/backend/index.ts', 'src/backend/testing/**'],
      // Thresholds disabled for now since unit tests use mocks
      // Enable as integration tests are added and coverage grows
    },
    setupFiles: ['./src/backend/testing/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@prisma-gen': path.resolve(__dirname, './prisma/generated'),
    },
  },
});
