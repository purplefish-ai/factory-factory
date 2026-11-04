/** Frontend-only workspace launcher responses; no event definition is created. */
export const eventWorkspaceHandlers = {
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
  'session.getLaunchOptions': () => ({
    provider: 'CLAUDE',
    model: 'sonnet',
    reasoning: {
      options: [{ value: 'default', label: 'Default' }],
      selected: 'default',
      defaultValue: 'default',
    },
    planMode: { supported: true, selected: false },
    accessMode: { options: [{ value: 'default', label: 'Default' }], selected: 'default' },
  }),
  'codexAccounts.list': () => [],
  'project.listSlashCommands': () => ({ commands: [] }),
  'project.listAllFiles': () => ({ files: [] }),
  'workspace.listForProject': () => ({ workspaces: [], reviewCount: 0 }),
};
