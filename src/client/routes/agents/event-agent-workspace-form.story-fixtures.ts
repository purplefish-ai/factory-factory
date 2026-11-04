import { z } from 'zod';
import type { StoryTrpcHandlers } from '@/client/lib/storybook-trpc';

function launchOptions(input: unknown) {
  const { provider, model } = z
    .object({ provider: z.enum(['CLAUDE', 'CODEX']), model: z.string().optional() })
    .parse(input);
  const effort = provider === 'CODEX' ? 'low' : 'default';
  const access = provider === 'CODEX' ? 'workspace-write' : 'default';
  return {
    provider,
    model,
    reasoning: {
      options: [{ value: effort, label: provider === 'CODEX' ? 'Low' : 'Default' }],
      selected: effort,
      defaultValue: effort,
    },
    planMode: { supported: true, selected: false },
    accessMode: {
      options: [{ value: access, label: provider === 'CODEX' ? 'Workspace write' : 'Default' }],
      selected: access,
    },
  };
}

/** Frontend-only workspace launcher responses; no event definition is created. */
export const eventWorkspaceHandlers: StoryTrpcHandlers = {
  'userSettings.get': () => ({
    defaultSessionProvider: 'CLAUDE',
    defaultClaudeModel: 'sonnet',
    defaultCodexModel: 'six-sol',
    ratchetEnabled: false,
    defaultClaudeReasoningEffort: null,
    defaultCodexReasoningEffort: null,
  }),
  'userSettings.getProviderOptions': () => ({
    CLAUDE: { models: [{ value: 'sonnet', label: 'Sonnet' }] },
    CODEX: { models: [{ value: 'six-sol', label: 'GPT-6.1-Sol' }] },
  }),
  'session.getLaunchOptions': launchOptions,
  'codexAccounts.list': () => [],
  'project.listSlashCommands': () => ({ commands: [] }),
  'project.listAllFiles': () => ({ files: [] }),
  'workspace.listForProject': () => ({ workspaces: [], reviewCount: 0 }),
  'workspace.create': (input) => {
    const values = z.object({ projectId: z.string(), name: z.string() }).parse(input);
    return {
      ...values,
      id: 'fixture-event-workspace',
      status: 'NEW',
      ratchetEnabled: false,
      createdAt: new Date('2026-11-04T12:00:00Z'),
    };
  },
};
