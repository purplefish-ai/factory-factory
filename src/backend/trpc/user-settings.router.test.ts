import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockGetWorkspaceOrder = vi.hoisted(() => vi.fn());
const mockUpdateWorkspaceOrder = vi.hoisted(() => vi.fn());
const mockExecCommand = vi.hoisted(() => vi.fn());
const mockFetchClaudeModelCatalogFromAcp = vi.hoisted(() => vi.fn());
const mockFetchCodexModelCatalogFromAppServer = vi.hoisted(() => vi.fn());

vi.mock('@/backend/lib/shell', () => ({
  execCommand: (...args: unknown[]) => mockExecCommand(...args),
}));

import { userSettingsRouter } from './user-settings.trpc';

function createCaller() {
  return userSettingsRouter.createCaller({
    appContext: {
      services: {
        fetchClaudeModelCatalogFromAcp: (...args: unknown[]) =>
          mockFetchClaudeModelCatalogFromAcp(...args),
        fetchCodexModelCatalogFromAppServer: (...args: unknown[]) =>
          mockFetchCodexModelCatalogFromAppServer(...args),
        userSettingsQueryService: {
          get: (...args: unknown[]) => mockGet(...args),
          update: (...args: unknown[]) => mockUpdate(...args),
          getWorkspaceOrder: (...args: unknown[]) => mockGetWorkspaceOrder(...args),
          updateWorkspaceOrder: (...args: unknown[]) => mockUpdateWorkspaceOrder(...args),
        },
      },
    },
  } as never);
}

describe('userSettingsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchClaudeModelCatalogFromAcp.mockReset();
    mockFetchCodexModelCatalogFromAppServer.mockReset();
    mockFetchClaudeModelCatalogFromAcp.mockResolvedValue([
      { id: 'default', displayName: 'Default', description: null },
    ]);
    mockFetchCodexModelCatalogFromAppServer.mockResolvedValue([
      {
        id: 'gpt-5-codex',
        displayName: 'GPT-5 Codex',
        description: null,
        supportedReasoningEfforts: [],
      },
    ]);
  });

  it('gets and updates settings', async () => {
    mockGet.mockResolvedValue({
      preferredIde: 'cursor',
      customIdeCommand: null,
      ratchetReplyToPrComments: true,
      defaultClaudeModel: 'sonnet',
      defaultCodexModel: 'default',
      defaultClaudeReasoningEffort: null,
      defaultCodexReasoningEffort: null,
    });
    mockUpdate.mockResolvedValue({
      preferredIde: 'vscode',
      customIdeCommand: null,
      ratchetReplyToPrComments: false,
      defaultClaudeModel: 'sonnet',
      defaultCodexModel: 'default',
      defaultClaudeReasoningEffort: null,
      defaultCodexReasoningEffort: null,
    });

    const caller = createCaller();
    await expect(caller.get()).resolves.toEqual({
      preferredIde: 'cursor',
      customIdeCommand: null,
      ratchetReplyToPrComments: true,
      defaultClaudeModel: 'sonnet',
      defaultCodexModel: 'default',
      defaultClaudeReasoningEffort: null,
      defaultCodexReasoningEffort: null,
    });
    await expect(
      caller.update({
        preferredIde: 'vscode',
        playSoundOnComplete: true,
        ratchetReplyToPrComments: false,
      })
    ).resolves.toEqual({
      preferredIde: 'vscode',
      customIdeCommand: null,
      ratchetReplyToPrComments: false,
      defaultClaudeModel: 'sonnet',
      defaultCodexModel: 'default',
      defaultClaudeReasoningEffort: null,
      defaultCodexReasoningEffort: null,
    });

    expect(mockUpdate).toHaveBeenCalledWith({
      preferredIde: 'vscode',
      playSoundOnComplete: true,
      ratchetReplyToPrComments: false,
    });
  });

  it('updates the ratchet review trigger mode', async () => {
    mockUpdate.mockResolvedValue({
      ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
    });

    const caller = createCaller();

    await expect(
      caller.update({
        ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
      })
    ).resolves.toEqual({
      ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
    });

    expect(mockUpdate).toHaveBeenCalledWith({
      ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
    });
  });

  it('requires command when preferred ide is custom', async () => {
    const caller = createCaller();
    await expect(caller.update({ preferredIde: 'custom' })).rejects.toThrow(
      'Custom IDE command is required when using custom IDE'
    );
  });

  it('passes provider default model updates through to the query service', async () => {
    mockUpdate.mockResolvedValue({
      preferredIde: 'cursor',
      customIdeCommand: null,
      defaultClaudeModel: 'Opus',
      defaultCodexModel: 'gpt-5-codex',
      defaultClaudeReasoningEffort: 'medium',
      defaultCodexReasoningEffort: 'high',
    });

    const caller = createCaller();

    await expect(
      caller.update({
        defaultClaudeModel: 'Opus',
        defaultCodexModel: 'gpt-5-codex',
        defaultClaudeReasoningEffort: 'medium',
        defaultCodexReasoningEffort: 'high',
      })
    ).resolves.toEqual({
      preferredIde: 'cursor',
      customIdeCommand: null,
      defaultClaudeModel: 'Opus',
      defaultCodexModel: 'gpt-5-codex',
      defaultClaudeReasoningEffort: 'medium',
      defaultCodexReasoningEffort: 'high',
    });

    expect(mockUpdate).toHaveBeenCalledWith({
      defaultClaudeModel: 'Opus',
      defaultCodexModel: 'gpt-5-codex',
      defaultClaudeReasoningEffort: 'medium',
      defaultCodexReasoningEffort: 'high',
    });
  });

  it('returns provider options from dynamic Claude and Codex catalogs', async () => {
    mockFetchClaudeModelCatalogFromAcp.mockResolvedValue([
      {
        id: 'default',
        displayName: 'Default — Opus 4.8 (1M)',
        description: 'Opus 4.8 with 1M context · Best for everyday tasks',
      },
      {
        id: 'claude-fable-5[1m]',
        displayName: 'Fable 5',
        description: 'Fable 5 · Most capable for hard tasks',
      },
      {
        id: 'sonnet',
        displayName: 'Sonnet 5',
        description: 'Sonnet 5 · Efficient for routine tasks',
      },
    ]);
    mockFetchCodexModelCatalogFromAppServer.mockResolvedValue([
      {
        id: 'gpt-5-codex',
        displayName: 'GPT-5 Codex',
        description: 'Coding model',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          { reasoningEffort: 'extra_high', description: 'Deep' },
        ],
      },
      {
        id: 'gpt-5-codex-mini',
        displayName: '',
        description: null,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Duplicate' },
          { reasoningEffort: 'medium-plus', description: null },
        ],
      },
    ]);

    await expect(createCaller().getProviderOptions()).resolves.toEqual({
      CLAUDE: {
        source: 'cli',
        models: [
          {
            value: 'default',
            label: 'Default — Opus 4.8 (1M)',
            description: 'Opus 4.8 with 1M context · Best for everyday tasks',
          },
          {
            value: 'claude-fable-5[1m]',
            label: 'Fable 5',
            description: 'Fable 5 · Most capable for hard tasks',
          },
          {
            value: 'sonnet',
            label: 'Sonnet 5',
            description: 'Sonnet 5 · Efficient for routine tasks',
          },
        ],
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
      CODEX: {
        source: 'cli',
        models: [
          { value: 'gpt-5-codex', label: 'GPT-5 Codex', description: 'Coding model' },
          { value: 'gpt-5-codex-mini', label: 'gpt-5-codex-mini', description: null },
        ],
        efforts: [
          { value: 'low', label: 'Low', description: 'Fast' },
          { value: 'extra_high', label: 'Extra High', description: 'Deep' },
          { value: 'medium-plus', label: 'Medium Plus' },
        ],
      },
    });
  });

  it('falls back to static Codex provider options when catalog loading fails', async () => {
    mockFetchCodexModelCatalogFromAppServer.mockRejectedValue(new Error('codex unavailable'));

    await expect(createCaller().getProviderOptions()).resolves.toMatchObject({
      CODEX: {
        source: 'fallback',
        error: 'codex unavailable',
        models: [
          { value: 'default', label: 'Default' },
          { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
        ],
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
    });
  });

  it('falls back to static Claude options without affecting dynamic Codex options', async () => {
    mockFetchClaudeModelCatalogFromAcp.mockRejectedValue(new Error('claude unavailable'));

    await expect(createCaller().getProviderOptions()).resolves.toMatchObject({
      CLAUDE: {
        source: 'fallback',
        error: 'claude unavailable',
        models: [
          { value: 'sonnet', label: 'Sonnet' },
          { value: 'opus', label: 'Opus' },
          { value: 'haiku', label: 'Haiku' },
          { value: 'fable', label: 'Fable' },
        ],
      },
      CODEX: { source: 'cli' },
    });
  });

  it('keeps dynamic Claude options when Codex catalog loading fails', async () => {
    mockFetchClaudeModelCatalogFromAcp.mockResolvedValue([
      {
        id: 'claude-fable-5[1m]',
        displayName: 'Fable 5',
        description: 'Fable 5 · Most capable for hard tasks',
      },
    ]);
    mockFetchCodexModelCatalogFromAppServer.mockRejectedValue(new Error('codex unavailable'));

    await expect(createCaller().getProviderOptions()).resolves.toMatchObject({
      CLAUDE: {
        source: 'cli',
        models: [
          {
            value: 'claude-fable-5[1m]',
            label: 'Fable 5',
            description: 'Fable 5 · Most capable for hard tasks',
          },
        ],
      },
      CODEX: {
        source: 'fallback',
        error: 'codex unavailable',
      },
    });
  });

  it('starts both provider catalog discoveries concurrently', async () => {
    let resolveClaude: (value: unknown) => void;
    let resolveCodex: (value: unknown) => void;
    const claudeCatalog = new Promise((resolve) => {
      resolveClaude = resolve;
    });
    const codexCatalog = new Promise((resolve) => {
      resolveCodex = resolve;
    });
    mockFetchClaudeModelCatalogFromAcp.mockReturnValue(claudeCatalog);
    mockFetchCodexModelCatalogFromAppServer.mockReturnValue(codexCatalog);

    const providerOptions = createCaller().getProviderOptions();
    await Promise.resolve();

    expect(mockFetchClaudeModelCatalogFromAcp).toHaveBeenCalledTimes(1);
    expect(mockFetchCodexModelCatalogFromAppServer).toHaveBeenCalledTimes(1);

    resolveClaude!([{ id: 'default', displayName: 'Default', description: null }]);
    resolveCodex!([
      {
        id: 'gpt-5-codex',
        displayName: 'GPT-5 Codex',
        description: null,
        supportedReasoningEfforts: [],
      },
    ]);
    await providerOptions;
  });

  it('tests custom command and validates command format', async () => {
    mockExecCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const caller = createCaller();

    await expect(caller.testCustomCommand({ customCommand: 'echo {workspace}' })).resolves.toEqual({
      success: true,
      message: 'Command executed successfully',
    });
    expect(mockExecCommand).toHaveBeenCalled();

    await expect(caller.testCustomCommand({ customCommand: 'echo nope' })).rejects.toThrow(
      'Command must include {workspace} placeholder'
    );

    await expect(
      caller.testCustomCommand({ customCommand: 'echo {workspace}; rm -rf /' })
    ).rejects.toThrow('Command contains invalid shell metacharacters');

    mockExecCommand.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(caller.testCustomCommand({ customCommand: 'echo {workspace}' })).rejects.toThrow(
      'Command failed: spawn failed'
    );
  });

  it('gets and updates workspace order', async () => {
    mockGetWorkspaceOrder.mockResolvedValue(['w2', 'w1']);
    mockUpdateWorkspaceOrder.mockResolvedValue(undefined);

    const caller = createCaller();
    await expect(caller.getWorkspaceOrder({ projectId: 'p1' })).resolves.toEqual(['w2', 'w1']);
    await expect(
      caller.updateWorkspaceOrder({ projectId: 'p1', workspaceIds: ['w1', 'w2'] })
    ).resolves.toEqual({ success: true });

    expect(mockUpdateWorkspaceOrder).toHaveBeenCalledWith('p1', ['w1', 'w2']);
  });
});
