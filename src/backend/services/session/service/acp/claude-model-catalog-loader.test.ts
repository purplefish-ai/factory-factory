import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchClaudeModelCatalogFromAcp } from './claude-model-catalog-loader';

const { mockCloseSession, mockDispose, mockInitialize, mockNewSession } = vi.hoisted(() => ({
  mockCloseSession: vi.fn(),
  mockDispose: vi.fn(),
  mockInitialize: vi.fn(),
  mockNewSession: vi.fn(),
}));

vi.mock('@agentclientprotocol/claude-agent-acp', () => ({
  ClaudeAcpAgent: class {
    initialize = mockInitialize;
    newSession = mockNewSession;
    closeSession = mockCloseSession;
    dispose = mockDispose;
  },
}));

const catalogSession = {
  sessionId: 'catalog-session',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'default',
      options: [
        {
          value: 'default',
          name: 'Default (recommended)',
          description: 'Opus 4.8 with 1M context · Best for everyday tasks',
        },
        {
          value: 'claude-fable-5[1m]',
          name: 'Fable',
          description: 'Fable 5 · Most capable for hard tasks',
        },
        {
          value: 'sonnet',
          name: 'Sonnet',
          description: 'Sonnet 5 · Efficient for routine tasks',
        },
      ],
    },
  ],
};

describe('fetchClaudeModelCatalogFromAcp', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockInitialize.mockResolvedValue({});
    mockCloseSession.mockResolvedValue({});
    mockDispose.mockResolvedValue(undefined);
  });

  it('returns formatted model options from an ephemeral ACP session', async () => {
    mockNewSession.mockResolvedValue(catalogSession);

    expect(await fetchClaudeModelCatalogFromAcp()).toEqual([
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
    expect(mockNewSession).toHaveBeenCalledWith({
      cwd: tmpdir(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            persistSession: false,
            settingSources: ['user'],
            tools: [],
          },
        },
      },
    });
    expect(mockCloseSession).toHaveBeenCalledWith({ sessionId: 'catalog-session' });
    expect(mockDispose).toHaveBeenCalledOnce();
  });

  it('closes and disposes when the session has no model config option', async () => {
    mockNewSession.mockResolvedValue({
      sessionId: 'catalog-session',
      configOptions: [],
    });

    await expect(fetchClaudeModelCatalogFromAcp()).rejects.toThrow(
      'Claude ACP session did not provide model options'
    );
    expect(mockCloseSession).toHaveBeenCalledWith({ sessionId: 'catalog-session' });
    expect(mockDispose).toHaveBeenCalledOnce();
  });

  it('disposes without closing when initialization fails', async () => {
    mockInitialize.mockRejectedValue(new Error('initialization failed'));

    await expect(fetchClaudeModelCatalogFromAcp()).rejects.toThrow('initialization failed');
    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(mockDispose).toHaveBeenCalledOnce();
  });

  it('disposes without closing when newSession fails before returning an ID', async () => {
    mockNewSession.mockRejectedValue(new Error('new session failed'));

    await expect(fetchClaudeModelCatalogFromAcp()).rejects.toThrow('new session failed');
    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(mockDispose).toHaveBeenCalledOnce();
  });

  it('disposes and surfaces the error when closing the catalog session fails', async () => {
    mockNewSession.mockResolvedValue(catalogSession);
    mockCloseSession.mockRejectedValue(new Error('close failed'));

    await expect(fetchClaudeModelCatalogFromAcp()).rejects.toThrow('close failed');
    expect(mockDispose).toHaveBeenCalledOnce();
  });
});
