import { globSync } from 'node:fs';
import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { coverage } from './vitest.coverage';

// Keep whole-window replacements, native HTTP, cache reference identity and
// cross-realm strict equality tests in their original process realms.
const frontendForkTests = new Set([
  'src/client/components/factory-update-banner.test.tsx',
  'src/client/features/chat/agent-activity/tool-renderers/tool-expansion-state.test.ts',
  'src/client/features/workspace/closed-session-transcript-items.test.ts',
  'src/client/hooks/workspace-cache-reconciler.integration.test.tsx',
  'src/client/hooks/workspace-detail-removal.integration.test.ts',
  'src/client/lib/trpc.integration.test.ts',
  'src/client/lib/workspace-cache-reconciler.test.ts',
  'src/client/lib/workspace-summary-reconciliation.test.ts',
  'src/components/ui/mermaid-diagram.integration.test.tsx',
]);

// Frontend suites preserve fresh per-file module/global contexts, including
// Node-environment utility tests. Backend native and process suites keep forks.
const frontendVmTests = globSync(
  ['src/client/**/*.test.{ts,tsx}', 'src/components/**/*.test.{ts,tsx}'],
  { cwd: import.meta.dirname }
)
  .map((file) => file.replaceAll('\\', '/'))
  .filter((file) => !frontendForkTests.has(file));

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
    globalSetup: ['./src/backend/testing/integration-db.global-setup.ts'],
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, '**/prisma/migrations/**'],
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
            'lint-rules/**/*.test.ts',
          ],
          exclude: ['node_modules', 'dist', '.next', ...frontendVmTests, ...reusableSharedTests],
        },
      },
      {
        extends: true,
        test: {
          name: 'frontend',
          include: frontendVmTests,
          // Keep fresh VM contexts/windows while reusing expensive jsdom imports.
          // Backend native modules and process APIs retain the forks pool above.
          pool: 'vmForks',
          vmMemoryLimit: '512MB',
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
    coverage,
    setupFiles: ['./src/backend/testing/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@prisma-gen': path.resolve(import.meta.dirname, './prisma/generated'),
    },
  },
});
