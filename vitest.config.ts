import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'electron/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.next'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      include: ['src/backend/**/*.ts'],
      exclude: [
        'src/backend/**/*.test.ts',
        'src/backend/index.ts',
        'src/backend/testing/**',
        // Keep coverage focused on behavior-bearing modules.
        'src/backend/**/index.ts',
        'src/backend/**/types.ts',
        'src/backend/**/*.types.ts',
        'src/backend/**/bridges.ts',
        'src/backend/**/constants.ts',
      ],
      thresholds: {
        lines: 82,
        statements: 82,
        functions: 84,
        branches: 72,
      },
    },
    setupFiles: ['./src/backend/testing/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@prisma-gen': path.resolve(__dirname, './prisma/generated'),
      '@factory-factory/core-types': path.resolve(__dirname, './packages/core/src/types'),
    },
  },
});
