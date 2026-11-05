import type { CoverageOptions } from 'vitest/node';

export const coverage = {
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
} satisfies CoverageOptions;
