import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  loadClaudeSessionHistory: vi.fn(),
  loadCodexSessionHistory: vi.fn(),
  getRuntimeSnapshot: vi.fn(),
  getChatBarCapabilities: vi.fn(),
  getSessionConfigOptionsWithFallback: vi.fn(),
  subscribe: vi.fn(),
  emitDelta: vi.fn(),
  getTranscriptSnapshot: vi.fn(),
  isHistoryHydrated: vi.fn(),
  canAttemptHistoryHydration: vi.fn(),
  setHistoryRetryAt: vi.fn(),
  clearHistoryRetryCooldown: vi.fn(),
  markHistoryHydrated: vi.fn(),
  replaceTranscript: vi.fn(),
  consumeInitialMessage: vi.fn(),
  enqueue: vi.fn(),
  getCachedCommands: vi.fn(),
  tryDispatchNextMessage: vi.fn(),
}));

vi.mock('@/backend/resource_accessors/agent-session.accessor', () => ({
  agentSessionAccessor: {
    findById: mocks.findById,
  },
}));

vi.mock('@/backend/domains/session/data/session-history-loader.service', () => ({
  claudeSessionHistoryLoaderService: {
    loadSessionHistory: mocks.loadClaudeSessionHistory,
  },
}));

vi.mock('@/backend/domains/session/data/codex-session-history-loader.service', () => ({
  codexSessionHistoryLoaderService: {
    loadSessionHistory: mocks.loadCodexSessionHistory,
  },
}));

vi.mock('@/backend/domains/session/lifecycle/session.service', () => ({
  sessionService: {
    getRuntimeSnapshot: mocks.getRuntimeSnapshot,
    getChatBarCapabilities: mocks.getChatBarCapabilities,
    getSessionConfigOptionsWithFallback: mocks.getSessionConfigOptionsWithFallback,
  },
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: {
    subscribe: mocks.subscribe,
    emitDelta: mocks.emitDelta,
    getTranscriptSnapshot: mocks.getTranscriptSnapshot,
    isHistoryHydrated: mocks.isHistoryHydrated,
    canAttemptHistoryHydration: mocks.canAttemptHistoryHydration,
    setHistoryRetryAt: mocks.setHistoryRetryAt,
    clearHistoryRetryCooldown: mocks.clearHistoryRetryCooldown,
    markHistoryHydrated: mocks.markHistoryHydrated,
    replaceTranscript: mocks.replaceTranscript,
    consumeInitialMessage: mocks.consumeInitialMessage,
    enqueue: mocks.enqueue,
  },
}));

vi.mock('@/backend/domains/session/store/slash-command-cache.service', () => ({
  slashCommandCacheService: {
    getCachedCommands: mocks.getCachedCommands,
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createLoadSessionHandler } from './load-session.handler';

describe('createLoadSessionHandler', () => {
  beforeEach(() => {
    const historyRetryAtBySession = new Map<string, number>();
    const pruneExpiredHistoryRetryEntries = (now: number): void => {
      for (const [trackedSessionId, retryAt] of historyRetryAtBySession) {
        if (retryAt <= now) {
          historyRetryAtBySession.delete(trackedSessionId);
        }
      }
    };
    const evictHistoryRetryEntryWithEarliestRetryAt = (): void => {
      let sessionIdToEvict: string | undefined;
      let earliestRetryAt = Number.POSITIVE_INFINITY;

      for (const [trackedSessionId, retryAt] of historyRetryAtBySession) {
        if (retryAt < earliestRetryAt) {
          earliestRetryAt = retryAt;
          sessionIdToEvict = trackedSessionId;
        }
      }

      if (sessionIdToEvict) {
        historyRetryAtBySession.delete(sessionIdToEvict);
      }
    };

    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.canAttemptHistoryHydration.mockImplementation((sessionId: string) => {
      const now = Date.now();
      pruneExpiredHistoryRetryEntries(now);
      const retryAt = historyRetryAtBySession.get(sessionId);
      if (retryAt === undefined) {
        return true;
      }
      return retryAt <= now;
    });
    mocks.setHistoryRetryAt.mockImplementation((sessionId: string, retryAt: number) => {
      const now = Date.now();
      pruneExpiredHistoryRetryEntries(now);

      if (!historyRetryAtBySession.has(sessionId) && historyRetryAtBySession.size >= 1024) {
        evictHistoryRetryEntryWithEarliestRetryAt();
      }

      historyRetryAtBySession.set(sessionId, retryAt);
    });
    mocks.clearHistoryRetryCooldown.mockImplementation((sessionId: string) => {
      historyRetryAtBySession.delete(sessionId);
    });
    mocks.getRuntimeSnapshot.mockReturnValue({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-02-14T00:00:00.000Z',
    });
    mocks.getChatBarCapabilities.mockResolvedValue({
      provider: 'CLAUDE',
      model: { enabled: false, options: [] },
      reasoning: { enabled: false, options: [] },
      thinking: { enabled: false },
      planMode: { enabled: true },
      attachments: { enabled: true, kinds: ['image', 'text'] },
      slashCommands: { enabled: false },
      usageStats: { enabled: false, contextWindow: false },
      rewind: { enabled: false },
    });
    mocks.getCachedCommands.mockResolvedValue(null);
    mocks.getSessionConfigOptionsWithFallback.mockResolvedValue([]);
    mocks.getTranscriptSnapshot.mockReturnValue([]);
    mocks.isHistoryHydrated.mockReturnValue(true);
    mocks.consumeInitialMessage.mockReturnValue(null);
    mocks.enqueue.mockReturnValue({ position: 0 });
    mocks.loadClaudeSessionHistory.mockResolvedValue({ status: 'not_found' });
    mocks.loadCodexSessionHistory.mockResolvedValue({ status: 'not_found' });
  });

  it('hydrates Claude transcript from JSONL history', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      model: 'claude-sonnet-4-5',
      providerSessionId: 'provider-session-1',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(false);
    mocks.loadClaudeSessionHistory.mockResolvedValue({
      status: 'loaded',
      filePath: '/tmp/.claude/projects/-tmp-worktree/provider-session-1.jsonl',
      history: [
        {
          type: 'user',
          content: 'hello',
          timestamp: '2026-02-14T00:00:00.000Z',
        },
      ],
    });

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session', loadRequestId: 'load-1' } as never,
    });

    expect(mocks.loadClaudeSessionHistory).toHaveBeenCalledWith({
      providerSessionId: 'provider-session-1',
      workingDir: '/tmp/worktree',
    });
    expect(mocks.replaceTranscript).toHaveBeenCalledWith(
      'session-1',
      expect.arrayContaining([
        expect.objectContaining({
          source: 'user',
          text: 'hello',
        }),
      ]),
      { historySource: 'jsonl' }
    );
    expect(mocks.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        loadRequestId: 'load-1',
      })
    );
  });

  it('marks Claude history hydration as none when JSONL file is not found', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      model: 'claude-sonnet-4-5',
      providerSessionId: 'provider-session-1',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(false);
    mocks.loadClaudeSessionHistory.mockResolvedValue({ status: 'not_found' });

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.markHistoryHydrated).toHaveBeenCalledWith('session-1', 'none');
  });

  it('does not mark history hydrated when JSONL read fails', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      model: 'claude-sonnet-4-5',
      providerSessionId: 'provider-session-1',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(false);
    mocks.loadClaudeSessionHistory.mockResolvedValue({
      status: 'error',
      reason: 'read_failed',
      filePath: '/tmp/.claude/projects/-tmp-worktree/provider-session-1.jsonl',
    });

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.markHistoryHydrated).not.toHaveBeenCalled();
    expect(mocks.replaceTranscript).not.toHaveBeenCalled();
  });

  it('throttles repeated Claude history reads after read failures', async () => {
    vi.useFakeTimers();
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      model: 'claude-sonnet-4-5',
      providerSessionId: 'provider-session-1',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(false);
    mocks.loadClaudeSessionHistory.mockResolvedValue({
      status: 'error',
      reason: 'read_failed',
      filePath: '/tmp/.claude/projects/-tmp-worktree/provider-session-1.jsonl',
    });

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-retry-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });
    await handler({
      ws: ws as never,
      sessionId: 'session-retry-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadClaudeSessionHistory).toHaveBeenCalledTimes(1);
    expect(mocks.markHistoryHydrated).not.toHaveBeenCalled();
  });

  it('evicts oldest retry entries to keep retry tracking bounded', async () => {
    vi.useFakeTimers();
    mocks.findById.mockImplementation(async (sessionId: string) => ({
      provider: 'CLAUDE',
      status: 'IDLE',
      model: 'claude-sonnet-4-5',
      providerSessionId: `provider-${sessionId}`,
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    }));
    mocks.isHistoryHydrated.mockReturnValue(false);
    mocks.loadClaudeSessionHistory.mockResolvedValue({
      status: 'error',
      reason: 'read_failed',
      filePath: '/tmp/.claude/projects/-tmp-worktree/provider-session.jsonl',
    });

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };

    for (let i = 0; i <= 1024; i += 1) {
      await handler({
        ws: ws as never,
        sessionId: `retry-cap-${i}`,
        workingDir: '/tmp/worktree',
        message: { type: 'load_session' } as never,
      });
    }

    await handler({
      ws: ws as never,
      sessionId: 'retry-cap-0',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadClaudeSessionHistory).toHaveBeenCalledTimes(1026);
  });

  it('evicts earliest-expiring retry entry when at capacity', async () => {
    let nowMs = Date.parse('2026-02-14T00:00:10.000Z');
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      mocks.findById.mockImplementation(async (sessionId: string) => ({
        provider: 'CLAUDE',
        status: 'IDLE',
        model: 'claude-sonnet-4-5',
        providerSessionId: `provider-${sessionId}`,
        workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
      }));
      mocks.isHistoryHydrated.mockReturnValue(false);
      mocks.loadClaudeSessionHistory.mockResolvedValue({
        status: 'error',
        reason: 'read_failed',
        filePath: '/tmp/.claude/projects/-tmp-worktree/provider-session.jsonl',
      });

      const handler = createLoadSessionHandler({
        getClientCreator: () => null,
        tryDispatchNextMessage: mocks.tryDispatchNextMessage,
        setManualDispatchResume: vi.fn(),
      });
      const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };

      await handler({
        ws: ws as never,
        sessionId: 'retry-expiry-oldest',
        workingDir: '/tmp/worktree',
        message: { type: 'load_session' } as never,
      });

      nowMs = Date.parse('2026-02-14T00:00:00.000Z');
      for (let i = 0; i < 1023; i += 1) {
        await handler({
          ws: ws as never,
          sessionId: `retry-expiry-fill-${i}`,
          workingDir: '/tmp/worktree',
          message: { type: 'load_session' } as never,
        });
      }

      await handler({
        ws: ws as never,
        sessionId: 'retry-expiry-trigger',
        workingDir: '/tmp/worktree',
        message: { type: 'load_session' } as never,
      });

      const loadCallsBeforeRecheck = mocks.loadClaudeSessionHistory.mock.calls.length;
      await handler({
        ws: ws as never,
        sessionId: 'retry-expiry-oldest',
        workingDir: '/tmp/worktree',
        message: { type: 'load_session' } as never,
      });

      expect(mocks.loadClaudeSessionHistory.mock.calls.length).toBe(loadCallsBeforeRecheck);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('does not initialize CODEX sessions on passive load', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'IDLE',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
      providerSessionId: null,
      providerProjectPath: null,
    });

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadClaudeSessionHistory).not.toHaveBeenCalled();
    expect(mocks.loadCodexSessionHistory).not.toHaveBeenCalled();
    expect(mocks.markHistoryHydrated).not.toHaveBeenCalled();
  });

  it('hydrates CODEX transcript from JSONL history', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'IDLE',
      model: 'gpt-5.3-codex',
      providerSessionId: 'codex-provider-session-1',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(false);
    mocks.loadCodexSessionHistory.mockResolvedValue({
      status: 'loaded',
      filePath:
        '/tmp/.codex/sessions/2026/02/14/rollout-2026-02-14T00-00-00-codex-provider-session-1.jsonl',
      history: [
        {
          type: 'user',
          content: 'hello from codex',
          timestamp: '2026-02-14T00:00:00.000Z',
        },
      ],
    });

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-codex-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session', loadRequestId: 'load-codex-1' } as never,
    });

    expect(mocks.loadCodexSessionHistory).toHaveBeenCalledWith({
      providerSessionId: 'codex-provider-session-1',
      workingDir: '/tmp/worktree',
    });
    expect(mocks.replaceTranscript).toHaveBeenCalledWith(
      'session-codex-1',
      expect.arrayContaining([
        expect.objectContaining({
          source: 'user',
          text: 'hello from codex',
        }),
      ]),
      { historySource: 'jsonl' }
    );
    expect(mocks.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-codex-1',
        loadRequestId: 'load-codex-1',
      })
    );
  });

  it('emits config options using fallback-aware session service method', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      model: 'claude-sonnet-4-5',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
      providerSessionId: null,
      providerProjectPath: null,
    });
    mocks.isHistoryHydrated.mockReturnValue(false);
    mocks.getSessionConfigOptionsWithFallback.mockResolvedValue([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'claude-sonnet-4-5',
        options: [{ value: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
      },
    ]);

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
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
          type: 'select',
          category: 'model',
          currentValue: 'claude-sonnet-4-5',
          options: [{ value: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
        },
      ],
    });
  });

  it('auto-enqueues and dispatches initial message when present', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      model: 'claude-sonnet-4-5',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
      providerSessionId: null,
      providerProjectPath: null,
    });
    mocks.consumeInitialMessage.mockReturnValue('Take a screenshot of the app');

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session', loadRequestId: 'load-1' } as never,
    });

    expect(mocks.consumeInitialMessage).toHaveBeenCalledWith('session-1');
    expect(mocks.enqueue).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ text: 'Take a screenshot of the app' })
    );
    expect(mocks.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'message_state_changed' })
    );
    expect(mocks.tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
  });
});
