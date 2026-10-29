import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Audited tests that clean up resources without module mocks or shared global
// mutations. New files stay isolated; remove an entry if it needs isolation.
const reusableSharedTests = [
  'src/shared/appearance.test.ts',
  'src/shared/chat-capabilities.test.ts',
  'src/shared/ci-status.test.ts',
  'src/shared/deepgram-voices.test.ts',
  'src/shared/github-pr-preview.test.ts',
  'src/shared/github-url.test.ts',
  'src/shared/issue-start-prompt.test.ts',
  'src/shared/kanban-column-projection.test.ts',
  'src/shared/pending-request-types.test.ts',
  'src/shared/pr-monitoring-status.test.ts',
  'src/shared/pr-monitoring.test.ts',
  'src/shared/pr-trigger-policy.test.ts',
  'src/shared/proxy-utils.test.ts',
  'src/shared/search.test.ts',
  'src/shared/session-runtime.test.ts',
  'src/shared/voice-vad.test.ts',
  'src/shared/workspace-flow-state.test.ts',
  'src/shared/workspace-pr-summary.test.ts',
  'src/shared/workspace-pr.test.ts',
  'src/shared/workspace-sidebar-status.test.ts',
  'src/shared/workspace-snapshot.test.ts',
  'src/shared/workspace-status-reason.test.ts',
  'src/shared/workspace-summary.test.ts',
  'src/shared/workspace-words.test.ts',
  'src/shared/acp-protocol/plan-content.test.ts',
  'src/shared/acp-protocol/protocol.test.ts',
  'src/shared/acp-protocol/question-validation.test.ts',
  'src/shared/acp-protocol/session-update-translator.compaction.test.ts',
  'src/shared/acp-protocol/session-update-translator.terminal-output.test.ts',
  'src/shared/acp-protocol/session-update-translator.test.ts',
  'src/shared/acp-protocol/subagents.test.ts',
  'src/shared/core/ci-status.test.ts',
  'src/shared/core/enums.drift.test.ts',
  'src/shared/core/ratchet-state.test.ts',
  'src/shared/schemas/auto-iteration.schema.test.ts',
  'src/shared/schemas/export-data.schema.test.ts',
  'src/shared/schemas/pr-event.schema.test.ts',
  'src/shared/schemas/pr-monitoring-backup.schema.test.ts',
  'src/shared/websocket/chat-message.schema.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Let jsdom own browser storage instead of Node's experimental global.
    execArgv: ['--no-experimental-webstorage'],
    env: {
      NODE_ENV: 'test',
    },
    exclude: ['node_modules', 'dist', '.next'],
    projects: [
      {
        extends: true,
        test: {
          name: 'isolated',
          include: [
            'src/**/*.test.ts',
            'src/**/*.test.tsx',
            'electron/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: ['node_modules', 'dist', '.next', ...reusableSharedTests],
        },
      },
      {
        extends: true,
        test: {
          name: 'shared',
          include: reusableSharedTests,
          // These contract/utility tests clean up their resources and do not
          // mock modules or mutate global state. Reuse their module graph while
          // keeping application, browser and native tests isolated above.
          pool: 'threads',
          isolate: false,
        },
      },
    ],
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
      '@': path.resolve(import.meta.dirname, './src'),
      '@prisma-gen': path.resolve(import.meta.dirname, './prisma/generated'),
    },
  },
});
