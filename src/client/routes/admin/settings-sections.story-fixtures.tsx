import { type ReactNode, useState } from 'react';
import { fn } from 'storybook/test';
import {
  STORY_TRPC_PENDING,
  StoryTrpcProvider,
  type StoryTrpcHandlers,
} from '@/client/lib/storybook-trpc';
import type { FactoryConfig } from '@/shared/schemas/factory-config.schema';

export const onRequest = fn<(path: string, input: unknown) => void>();
const defaultSettings = {
  playSoundOnComplete: true,
  childWorkspacesEnabled: true,
  ticketDispatchPrompt: null as string | null,
  preferredIde: 'cursor',
  customIdeCommand: null as string | null,
  defaultSessionProvider: 'CLAUDE',
  defaultClaudeModel: 'sonnet',
  defaultCodexModel: 'default',
  defaultClaudeReasoningEffort: null,
  defaultCodexReasoningEffort: null,
  defaultWorkspacePermissions: 'STRICT',
  automationPermissions: 'RELAXED',
  ratchetEnabled: false,
  ratchetReplyToPrComments: true,
  ratchetReviewTriggerMode: 'CHANGES_REQUESTED',
  appearanceColorScheme: 'factory',
  appearanceBackgroundColor: null as string | null,
  appearanceForegroundColor: null as string | null,
  appearanceFontScale: 100,
  appearanceFontSans: null as string | null,
  appearanceFontMono: null as string | null,
};

// Stateful handlers keep these interactive examples independent of a running backend.
export function SettingsStoryProvider({
  children,
  settings: initialSettings = {},
  loading = false,
  refreshDelayMs = 0,
  failRequests = [],
  pendingRequests = [],
  factoryConfig = null,
}: {
  children: ReactNode;
  settings?: Partial<typeof defaultSettings>;
  loading?: boolean;
  refreshDelayMs?: number;
  failRequests?: string[];
  /** Paths that never answer, to show saving states. */
  pendingRequests?: string[];
  factoryConfig?: FactoryConfig | null;
}) {
  const [handlers] = useState(() => {
    let settings = { ...defaultSettings, ...initialSettings };
    let orphanedWorktrees = [
      {
        projectId: 'project-1',
        projectName: 'factory-factory',
        path: '/Users/me/factory-factory/worktrees/factory-factory/workspace-abc123',
      },
      {
        projectId: 'project-1',
        projectName: 'factory-factory',
        path: '/Users/me/factory-factory/worktrees/factory-factory/workspace-def456',
      },
    ];
    const responses: StoryTrpcHandlers = {
      'codexAccounts.list': () => [],
      'userSettings.get': () =>
        refreshDelayMs > 0
          ? new Promise((resolve) => setTimeout(() => resolve(settings), refreshDelayMs))
          : settings,
      'userSettings.update': (input) => {
        settings = { ...settings, ...(typeof input === 'object' ? input : {}) };
        return settings;
      },
      'userSettings.testCustomCommand': () => ({ success: true }),
      'userSettings.getProviderOptions': () => ({
        CLAUDE: {
          source: 'cli',
          models: [
            { value: 'default', label: 'Default — Opus 4.8 (1M)' },
            { value: 'claude-fable-5[1m]', label: 'Fable 5' },
            { value: 'sonnet', label: 'Sonnet 5' },
          ],
          efforts: [{ value: 'medium', label: 'Medium' }],
        },
        CODEX: {
          source: 'fallback',
          models: [
            { value: 'default', label: 'Default' },
            { value: 'gpt-test', label: 'Test Codex Model' },
          ],
          efforts: [{ value: 'medium', label: 'Medium' }],
        },
      }),
      'admin.checkCLIHealth': (input) => {
        const fresh =
          typeof input === 'object' &&
          input !== null &&
          'forceRefresh' in input &&
          input.forceRefresh === true;
        return {
          claude: { isInstalled: true, isAuthenticated: fresh },
          codex: { isInstalled: true, isAuthenticated: fresh },
          github: { isInstalled: true, isAuthenticated: fresh },
          allHealthy: fresh,
        };
      },
      'admin.downloadLogFile': () => 'Sample server log',
      'admin.getServerInfo': () => ({ backendPort: 3001 }),
      'admin.triggerRatchetCheck': () => ({ checked: 3, stateChanges: 1, actionsTriggered: 1 }),
      'workspace.getFactoryConfig': () => factoryConfig,
      'workspace.refreshFactoryConfigs': () => ({ updatedCount: 2, errors: [] }),
      'admin.listOrphanedWorktrees': () => orphanedWorktrees,
      'admin.removeOrphanedWorktrees': () => {
        const removed = orphanedWorktrees.map((orphan) => orphan.path);
        orphanedWorktrees = [];
        return { removed, failed: [] };
      },
      'admin.exportData': () => ({
        meta: { exportedAt: '2026-09-08T12:00:00Z', version: '0.4.7', schemaVersion: 4 },
        data: {
          projects: [],
          workspaces: [],
          agentSessions: [],
          terminalSessions: [],
          userSettings: null,
        },
      }),
    };
    const paths = new Set([...Object.keys(responses), ...failRequests]);
    return Object.fromEntries(
      [...paths].map((path) => [
        path,
        (input: unknown) => {
          if (loading || pendingRequests.includes(path)) {
            return STORY_TRPC_PENDING;
          }
          if (failRequests.includes(path)) {
            throw new Error(`Request rejected: ${path}`);
          }
          return responses[path]?.(input);
        },
      ])
    );
  });
  return (
    <StoryTrpcProvider handlers={handlers} onRequest={onRequest}>
      {/* Toasts render in the app Toaster that .storybook/preview.ts mounts. */}
      <div className="mx-auto w-full max-w-3xl">{children}</div>
    </StoryTrpcProvider>
  );
}
