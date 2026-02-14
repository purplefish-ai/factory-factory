import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  getRuntimeSnapshot: vi.fn(),
  getOrCreateSessionClientFromRecord: vi.fn(),
  getChatBarCapabilities: vi.fn(),
  getSessionConfigOptions: vi.fn(),
  subscribe: vi.fn(),
  emitDelta: vi.fn(),
  getTranscriptSnapshot: vi.fn(),
  getCachedCommands: vi.fn(),
}));

vi.mock('@/backend/resource_accessors/agent-session.accessor', () => ({
  agentSessionAccessor: {
    findById: mocks.findById,
  },
}));

vi.mock('@/backend/domains/session/lifecycle/session.service', () => ({
  sessionService: {
    getRuntimeSnapshot: mocks.getRuntimeSnapshot,
    getOrCreateSessionClientFromRecord: mocks.getOrCreateSessionClientFromRecord,
    getChatBarCapabilities: mocks.getChatBarCapabilities,
    getSessionConfigOptions: mocks.getSessionConfigOptions,
  },
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: {
    subscribe: mocks.subscribe,
    emitDelta: mocks.emitDelta,
    getTranscriptSnapshot: mocks.getTranscriptSnapshot,
  },
}));

vi.mock('@/backend/domains/session/store/slash-command-cache.service', () => ({
  slashCommandCacheService: {
    getCachedCommands: mocks.getCachedCommands,
  },
}));

import { createLoadSessionHandler } from './load-session.handler';

describe('createLoadSessionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeSnapshot.mockReturnValue({
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: '2026-02-13T00:00:00.000Z',
    });
    mocks.getChatBarCapabilities.mockResolvedValue({
      provider: 'CODEX',
      model: { enabled: false, options: [] },
      reasoning: { enabled: false, options: [] },
      thinking: { enabled: false },
      planMode: { enabled: true },
      attachments: { enabled: false, kinds: [] },
      slashCommands: { enabled: false },
      usageStats: { enabled: false, contextWindow: false },
      rewind: { enabled: false },
    });
    mocks.getCachedCommands.mockResolvedValue(null);
    mocks.getSessionConfigOptions.mockReturnValue([]);
    mocks.getOrCreateSessionClientFromRecord.mockResolvedValue({});
    mocks.getTranscriptSnapshot.mockReturnValue([]);
  });

  it('subscribes with no Claude hydration context for CODEX session', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'RUNNING',
      workspace: { worktreePath: '/tmp/worktree' },
      providerSessionId: null,
      providerProjectPath: null,
    });

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session', loadRequestId: 'load-1' } as never,
    });

    expect(mocks.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        loadRequestId: 'load-1',
      })
    );
    expect(mocks.getOrCreateSessionClientFromRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'CODEX',
      })
    );
  });

  it('emits cached slash commands when available', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'RUNNING',
      workspace: { worktreePath: '/tmp/worktree' },
      providerSessionId: null,
      providerProjectPath: null,
    });
    mocks.getCachedCommands.mockResolvedValue([{ name: '/test', description: 'Test command' }]);

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.emitDelta).toHaveBeenCalledWith('session-1', {
      type: 'slash_commands',
      slashCommands: [{ name: '/test', description: 'Test command' }],
    });
  });

  it('emits config options when ACP session handle is active', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'RUNNING',
      workspace: { worktreePath: '/tmp/worktree' },
      providerSessionId: null,
      providerProjectPath: null,
    });
    mocks.getSessionConfigOptions.mockReturnValue([
      {
        id: 'model',
        name: 'Model',
        type: 'string',
        category: 'model',
        currentValue: 'sonnet',
        options: [{ value: 'sonnet', name: 'Sonnet' }],
      },
    ]);

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.emitDelta).toHaveBeenCalledWith('session-1', {
      type: 'config_options_update',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'string',
          category: 'model',
          currentValue: 'sonnet',
          options: [{ value: 'sonnet', name: 'Sonnet' }],
        },
      ],
    });
  });

  it('sends websocket error when runtime initialization fails', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'RUNNING',
      workspace: { worktreePath: '/tmp/worktree' },
      providerSessionId: null,
      providerProjectPath: null,
    });
    mocks.getOrCreateSessionClientFromRecord.mockRejectedValueOnce(new Error('boom'));

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'Failed to initialize session: boom',
      })
    );
  });

  it('skips eager runtime init until workspace worktree path exists', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'RUNNING',
      workspace: { worktreePath: null },
      providerSessionId: null,
      providerProjectPath: null,
    });

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.getOrCreateSessionClientFromRecord).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to initialize session')
    );
  });

  it('skips eager runtime init for inactive sessions without replay context', async () => {
    mocks.getRuntimeSnapshot.mockReturnValue({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-02-13T00:00:00.000Z',
    });
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      workspace: { worktreePath: '/tmp/worktree' },
      providerSessionId: null,
      providerProjectPath: null,
    });

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.getOrCreateSessionClientFromRecord).not.toHaveBeenCalled();
  });

  it('eagerly initializes inactive sessions when transcript is already hydrated', async () => {
    mocks.getRuntimeSnapshot.mockReturnValue({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-02-13T00:00:00.000Z',
    });
    mocks.getTranscriptSnapshot.mockReturnValue([
      {
        id: 'm-1',
        source: 'user',
        text: 'hello',
        timestamp: '2026-02-13T00:00:01.000Z',
        order: 1,
      },
    ]);
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      workspace: { worktreePath: '/tmp/worktree' },
      providerSessionId: null,
      providerProjectPath: null,
    });

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.getOrCreateSessionClientFromRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'CLAUDE',
        providerSessionId: null,
      })
    );
  });

  it('eagerly initializes inactive sessions when providerSessionId is present', async () => {
    mocks.getRuntimeSnapshot.mockReturnValue({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-02-13T00:00:00.000Z',
    });
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'COMPLETED',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
      providerSessionId: 'provider-session-1',
      providerProjectPath: null,
    });

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.getOrCreateSessionClientFromRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'CODEX',
        providerSessionId: 'provider-session-1',
      })
    );
  });

  it('eagerly initializes inactive CODEX sessions to hydrate chat bar capabilities', async () => {
    mocks.getRuntimeSnapshot.mockReturnValue({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-02-13T00:00:00.000Z',
    });
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'IDLE',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
      providerSessionId: null,
      providerProjectPath: null,
    });

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.getOrCreateSessionClientFromRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'CODEX',
        status: 'IDLE',
      })
    );
  });

  it('skips eager runtime init for archived workspaces even with providerSessionId', async () => {
    mocks.getRuntimeSnapshot.mockReturnValue({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-02-13T00:00:00.000Z',
    });
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'COMPLETED',
      workspace: { status: 'ARCHIVED', worktreePath: '/tmp/worktree' },
      providerSessionId: 'provider-session-1',
      providerProjectPath: null,
    });

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.getOrCreateSessionClientFromRecord).not.toHaveBeenCalled();
  });
});
