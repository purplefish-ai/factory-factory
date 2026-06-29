import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  getHistoryHydrationSource: vi.fn(),
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

vi.mock('@/backend/services/session/resources/agent-session.accessor', () => ({
  agentSessionAccessor: {
    findById: mocks.findById,
  },
}));

vi.mock('@/backend/services/session/service/data/session-history-loader.service', () => ({
  claudeSessionHistoryLoaderService: {
    loadSessionHistory: mocks.loadClaudeSessionHistory,
  },
}));

vi.mock('@/backend/services/session/service/data/codex-session-history-loader.service', () => ({
  codexSessionHistoryLoaderService: {
    loadSessionHistory: mocks.loadCodexSessionHistory,
  },
}));

vi.mock('@/backend/services/session/service/lifecycle/session.service', () => ({
  sessionService: {
    getRuntimeSnapshot: mocks.getRuntimeSnapshot,
    getChatBarCapabilities: mocks.getChatBarCapabilities,
    getSessionConfigOptionsWithFallback: mocks.getSessionConfigOptionsWithFallback,
  },
}));

vi.mock('@/backend/services/session/service/session-domain.service', () => ({
  sessionDomainService: {
    subscribe: mocks.subscribe,
    emitDelta: mocks.emitDelta,
    getTranscriptSnapshot: mocks.getTranscriptSnapshot,
    isHistoryHydrated: mocks.isHistoryHydrated,
    getHistoryHydrationSource: mocks.getHistoryHydrationSource,
    canAttemptHistoryHydration: mocks.canAttemptHistoryHydration,
    setHistoryRetryAt: mocks.setHistoryRetryAt,
    clearHistoryRetryCooldown: mocks.clearHistoryRetryCooldown,
    markHistoryHydrated: mocks.markHistoryHydrated,
    replaceTranscript: mocks.replaceTranscript,
    consumeInitialMessage: mocks.consumeInitialMessage,
    enqueue: mocks.enqueue,
  },
}));

vi.mock('@/backend/services/session/service/store/slash-command-cache.service', () => ({
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
  const tempDirs: string[] = [];

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
    mocks.getHistoryHydrationSource.mockReturnValue(undefined);
    mocks.consumeInitialMessage.mockReturnValue(null);
    mocks.enqueue.mockReturnValue({ position: 0 });
    mocks.loadClaudeSessionHistory.mockResolvedValue({ status: 'not_found' });
    mocks.loadCodexSessionHistory.mockResolvedValue({ status: 'not_found' });
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('does not replace transcript when messages arrive while history load is in flight', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      model: 'claude-sonnet-4-5',
      providerSessionId: 'provider-session-race',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(false);

    let resolveHistoryLoad:
      | ((value: Awaited<ReturnType<typeof mocks.loadClaudeSessionHistory>>) => void)
      | undefined;
    const historyLoadPromise = new Promise<
      Awaited<ReturnType<typeof mocks.loadClaudeSessionHistory>>
    >((resolve) => {
      resolveHistoryLoad = resolve;
    });
    mocks.loadClaudeSessionHistory.mockReturnValue(historyLoadPromise);

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    const pendingHandle = handler({
      ws: ws as never,
      sessionId: 'session-race-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    await vi.waitFor(() => {
      expect(mocks.loadClaudeSessionHistory).toHaveBeenCalledTimes(1);
    });

    mocks.getTranscriptSnapshot.mockReturnValue([
      {
        id: 'msg-during-load',
        source: 'user',
        text: 'arrived while loading',
        timestamp: '2026-02-14T00:00:10.000Z',
      },
    ]);

    resolveHistoryLoad?.({
      status: 'loaded',
      filePath: '/tmp/.claude/projects/-tmp-worktree/provider-session-race.jsonl',
      history: [
        {
          type: 'assistant',
          content: 'historical reply',
          timestamp: '2026-02-14T00:00:00.000Z',
        },
      ],
    });

    await pendingHandle;

    expect(mocks.replaceTranscript).not.toHaveBeenCalled();
    expect(mocks.markHistoryHydrated).toHaveBeenCalledWith('session-race-1', 'none');
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

  it('hydrates CODEX transcript using metadata providerSessionId when column is null', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'IDLE',
      model: 'gpt-5.3-codex',
      providerSessionId: null,
      providerMetadata: {
        acpConfigSnapshot: {
          provider: 'CODEX',
          providerSessionId: 'codex-provider-session-from-metadata',
          capturedAt: '2026-02-14T00:00:00.000Z',
          configOptions: [],
        },
      },
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(false);
    mocks.loadCodexSessionHistory.mockResolvedValue({
      status: 'loaded',
      filePath:
        '/tmp/.codex/sessions/2026/02/14/rollout-2026-02-14T00-00-00-codex-provider-session-from-metadata.jsonl',
      history: [
        {
          type: 'user',
          content: 'recovered from metadata id',
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
      sessionId: 'session-codex-metadata-id',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadCodexSessionHistory).toHaveBeenCalledWith({
      providerSessionId: 'codex-provider-session-from-metadata',
      workingDir: '/tmp/worktree',
    });
    expect(mocks.replaceTranscript).toHaveBeenCalledWith(
      'session-codex-metadata-id',
      expect.arrayContaining([
        expect.objectContaining({
          source: 'user',
          text: 'recovered from metadata id',
        }),
      ]),
      { historySource: 'jsonl' }
    );
    expect(mocks.markHistoryHydrated).not.toHaveBeenCalledWith('session-codex-metadata-id', 'none');
  });

  it('prefers CODEX providerSessionId column over metadata fallback', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'IDLE',
      model: 'gpt-5.3-codex',
      providerSessionId: 'codex-provider-session-column',
      providerMetadata: {
        acpConfigSnapshot: {
          provider: 'CODEX',
          providerSessionId: 'codex-provider-session-metadata',
          capturedAt: '2026-02-14T00:00:00.000Z',
          configOptions: [],
        },
      },
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(false);
    mocks.loadCodexSessionHistory.mockResolvedValue({ status: 'not_found' });

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-codex-column-id',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadCodexSessionHistory).toHaveBeenCalledWith({
      providerSessionId: 'codex-provider-session-column',
      workingDir: '/tmp/worktree',
    });
  });

  it('ignores metadata providerSessionId when snapshot provider differs', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'IDLE',
      model: 'gpt-5.3-codex',
      providerSessionId: null,
      providerMetadata: {
        acpConfigSnapshot: {
          provider: 'CLAUDE',
          providerSessionId: 'claude-provider-session-from-metadata',
          capturedAt: '2026-02-14T00:00:00.000Z',
          configOptions: [],
        },
      },
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(false);

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-codex-mismatched-metadata-id',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadCodexSessionHistory).not.toHaveBeenCalled();
    expect(mocks.markHistoryHydrated).toHaveBeenCalledWith(
      'session-codex-mismatched-metadata-id',
      'none'
    );
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

  it('backfills missing CODEX tool calls from JSONL when a live transcript already exists', async () => {
    const existingTranscript = [
      {
        id: 'existing-user',
        source: 'user',
        text: 'start',
        timestamp: '2026-02-14T00:00:00.000Z',
        order: 0,
      },
      {
        id: 'existing-assistant-1',
        source: 'agent',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'before tool' }] },
        },
        timestamp: '2026-02-14T00:00:01.000Z',
        order: 1,
      },
      {
        id: 'existing-assistant-2',
        source: 'agent',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'after tool' }] },
        },
        timestamp: '2026-02-14T00:00:04.000Z',
        order: 2,
      },
    ];

    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'RUNNING',
      model: 'gpt-5.3-codex',
      providerSessionId: 'codex-provider-session-1',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(true);
    mocks.getTranscriptSnapshot.mockReturnValue(existingTranscript);
    mocks.loadCodexSessionHistory.mockResolvedValue({
      status: 'loaded',
      filePath:
        '/tmp/.codex/sessions/2026/02/14/rollout-2026-02-14T00-00-00-codex-provider-session-1.jsonl',
      history: [
        {
          type: 'assistant',
          content: 'before tool',
          timestamp: '2026-02-14T00:00:01.000Z',
        },
        {
          type: 'tool_use',
          content: '',
          timestamp: '2026-02-14T00:00:02.000Z',
          toolName: 'exec_command',
          toolId: 'call-missing',
          toolInput: { cmd: 'pwd', workdir: '/missing' },
        },
        {
          type: 'tool_result',
          content: 'failed before process start',
          timestamp: '2026-02-14T00:00:03.000Z',
          toolId: 'call-missing',
          isError: true,
        },
        {
          type: 'assistant',
          content: 'after tool',
          timestamp: '2026-02-14T00:00:04.000Z',
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
      sessionId: 'session-codex-backfill',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadCodexSessionHistory).toHaveBeenCalledWith({
      providerSessionId: 'codex-provider-session-1',
      workingDir: '/tmp/worktree',
    });
    expect(mocks.replaceTranscript).toHaveBeenCalledTimes(1);
    const backfilledTranscript = mocks.replaceTranscript.mock.calls[0]?.[1] ?? [];
    expect(backfilledTranscript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agent',
          message: expect.objectContaining({
            type: 'stream_event',
            event: expect.objectContaining({
              content_block: expect.objectContaining({
                type: 'tool_use',
                id: 'call-missing',
                name: 'exec_command',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          source: 'agent',
          message: expect.objectContaining({
            type: 'user',
            message: expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'tool_result',
                  tool_use_id: 'call-missing',
                  content: 'failed before process start',
                  is_error: true,
                }),
              ]),
            }),
          }),
        }),
      ])
    );
    expect(backfilledTranscript.map((message: { order: number }) => message.order)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(mocks.replaceTranscript).toHaveBeenCalledWith(
      'session-codex-backfill',
      expect.any(Array),
      {
        historySource: 'jsonl',
      }
    );
  });

  it('does not duplicate CODEX tool calls already captured by the live transcript', async () => {
    const existingTranscript = [
      {
        id: 'existing-tool',
        source: 'agent',
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-present',
              name: 'exec_command',
              input: { cmd: 'pwd' },
            },
          },
        },
        timestamp: '2026-02-14T00:00:02.000Z',
        order: 0,
      },
      {
        id: 'existing-result',
        source: 'agent',
        message: {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-present', content: 'ok' }],
          },
        },
        timestamp: '2026-02-14T00:00:03.000Z',
        order: 1,
      },
    ];

    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'RUNNING',
      model: 'gpt-5.3-codex',
      providerSessionId: 'codex-provider-session-1',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(true);
    mocks.getTranscriptSnapshot.mockReturnValue(existingTranscript);
    mocks.loadCodexSessionHistory.mockResolvedValue({
      status: 'loaded',
      filePath:
        '/tmp/.codex/sessions/2026/02/14/rollout-2026-02-14T00-00-00-codex-provider-session-1.jsonl',
      history: [
        {
          type: 'tool_use',
          content: '',
          timestamp: '2026-02-14T00:00:02.000Z',
          toolName: 'exec_command',
          toolId: 'call-present',
          toolInput: { cmd: 'pwd' },
        },
        {
          type: 'tool_result',
          content: 'ok',
          timestamp: '2026-02-14T00:00:03.000Z',
          toolId: 'call-present',
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
      sessionId: 'session-codex-no-dup',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadCodexSessionHistory).toHaveBeenCalledTimes(1);
    expect(mocks.replaceTranscript).not.toHaveBeenCalled();
    expect(mocks.markHistoryHydrated).toHaveBeenCalledWith('session-codex-no-dup', 'none');
  });

  it('BUG: concurrent load_session calls can corrupt historyHydrationSource from jsonl to none', async () => {
    const existingTranscript = [
      {
        id: 'existing-user',
        source: 'user',
        text: 'start',
        timestamp: '2026-02-14T00:00:00.000Z',
        order: 0,
      },
      {
        id: 'existing-assistant-1',
        source: 'agent',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'before tool' }] },
        },
        timestamp: '2026-02-14T00:00:01.000Z',
        order: 1,
      },
      {
        id: 'existing-assistant-2',
        source: 'agent',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'after tool' }] },
        },
        timestamp: '2026-02-14T00:00:04.000Z',
        order: 2,
      },
    ];
    const loadedHistory = {
      status: 'loaded' as const,
      filePath:
        '/tmp/.codex/sessions/2026/02/14/rollout-2026-02-14T00-00-00-codex-provider-session-1.jsonl',
      history: [
        {
          type: 'assistant',
          content: 'before tool',
          timestamp: '2026-02-14T00:00:01.000Z',
        },
        {
          type: 'tool_use',
          content: '',
          timestamp: '2026-02-14T00:00:02.000Z',
          toolName: 'exec_command',
          toolId: 'call-concurrent',
          toolInput: { cmd: 'pwd', workdir: '/race' },
        },
        {
          type: 'tool_result',
          content: '/race',
          timestamp: '2026-02-14T00:00:03.000Z',
          toolId: 'call-concurrent',
        },
        {
          type: 'assistant',
          content: 'after tool',
          timestamp: '2026-02-14T00:00:04.000Z',
        },
      ],
    };

    let historyHydrationSource: 'jsonl' | 'acp_fallback' | 'none' | undefined = 'none';
    let latestTranscript = existingTranscript;
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'RUNNING',
      model: 'gpt-5.3-codex',
      providerSessionId: 'codex-provider-session-1',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockImplementation(() => historyHydrationSource !== undefined);
    mocks.getHistoryHydrationSource.mockImplementation(() => historyHydrationSource);
    mocks.getTranscriptSnapshot.mockImplementation(() => latestTranscript);
    mocks.markHistoryHydrated.mockImplementation(
      (_sessionId: string, source: 'jsonl' | 'acp_fallback' | 'none') => {
        historyHydrationSource = source;
      }
    );
    mocks.replaceTranscript.mockImplementation(
      (_sessionId: string, transcript: typeof existingTranscript) => {
        latestTranscript = transcript;
        historyHydrationSource = 'jsonl';
      }
    );

    let resolveFirstLoad:
      | ((value: Awaited<ReturnType<typeof mocks.loadCodexSessionHistory>>) => void)
      | undefined;
    let resolveSecondLoad:
      | ((value: Awaited<ReturnType<typeof mocks.loadCodexSessionHistory>>) => void)
      | undefined;
    const firstLoad = new Promise<Awaited<ReturnType<typeof mocks.loadCodexSessionHistory>>>(
      (resolve) => {
        resolveFirstLoad = resolve;
      }
    );
    const secondLoad = new Promise<Awaited<ReturnType<typeof mocks.loadCodexSessionHistory>>>(
      (resolve) => {
        resolveSecondLoad = resolve;
      }
    );
    mocks.loadCodexSessionHistory.mockReturnValueOnce(firstLoad).mockReturnValueOnce(secondLoad);

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    const firstHandle = handler({
      ws: ws as never,
      sessionId: 'session-codex-concurrent',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });
    const secondHandle = handler({
      ws: ws as never,
      sessionId: 'session-codex-concurrent',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    await vi.waitFor(() => {
      expect(mocks.loadCodexSessionHistory).toHaveBeenCalledTimes(2);
    });

    resolveFirstLoad?.(loadedHistory);
    await firstHandle;
    expect(historyHydrationSource).toBe('jsonl');

    resolveSecondLoad?.(loadedHistory);
    await secondHandle;

    expect(mocks.replaceTranscript).toHaveBeenCalledTimes(1);
    expect(mocks.markHistoryHydrated).not.toHaveBeenCalledWith('session-codex-concurrent', 'none');
    expect(historyHydrationSource).toBe('jsonl');
  });

  it('rechecks CODEX tool backfill after a no-op cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-14T00:00:10.000Z'));
    const existingTranscript = [
      {
        id: 'existing-tool',
        source: 'agent',
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-present',
              name: 'exec_command',
              input: { cmd: 'pwd' },
            },
          },
        },
        timestamp: '2026-02-14T00:00:02.000Z',
        order: 0,
      },
      {
        id: 'existing-result',
        source: 'agent',
        message: {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-present', content: 'ok' }],
          },
        },
        timestamp: '2026-02-14T00:00:03.000Z',
        order: 1,
      },
    ];

    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'RUNNING',
      model: 'gpt-5.3-codex',
      providerSessionId: 'codex-provider-session-1',
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(true);
    mocks.getHistoryHydrationSource.mockReturnValueOnce(undefined).mockReturnValue('none');
    mocks.getTranscriptSnapshot.mockReturnValue(existingTranscript);
    mocks.loadCodexSessionHistory
      .mockResolvedValueOnce({
        status: 'loaded',
        filePath:
          '/tmp/.codex/sessions/2026/02/14/rollout-2026-02-14T00-00-00-codex-provider-session-1.jsonl',
        history: [
          {
            type: 'tool_use',
            content: '',
            timestamp: '2026-02-14T00:00:02.000Z',
            toolName: 'exec_command',
            toolId: 'call-present',
            toolInput: { cmd: 'pwd' },
          },
          {
            type: 'tool_result',
            content: 'ok',
            timestamp: '2026-02-14T00:00:03.000Z',
            toolId: 'call-present',
          },
        ],
      })
      .mockResolvedValueOnce({
        status: 'loaded',
        filePath:
          '/tmp/.codex/sessions/2026/02/14/rollout-2026-02-14T00-00-00-codex-provider-session-1.jsonl',
        history: [
          {
            type: 'tool_use',
            content: '',
            timestamp: '2026-02-14T00:00:02.000Z',
            toolName: 'exec_command',
            toolId: 'call-present',
            toolInput: { cmd: 'pwd' },
          },
          {
            type: 'tool_result',
            content: 'ok',
            timestamp: '2026-02-14T00:00:03.000Z',
            toolId: 'call-present',
          },
          {
            type: 'tool_use',
            content: '',
            timestamp: '2026-02-14T00:00:04.000Z',
            toolName: 'exec_command',
            toolId: 'call-missing',
            toolInput: { cmd: 'whoami' },
          },
          {
            type: 'tool_result',
            content: 'martin',
            timestamp: '2026-02-14T00:00:05.000Z',
            toolId: 'call-missing',
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
      sessionId: 'session-codex-recheck',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadCodexSessionHistory).toHaveBeenCalledTimes(1);
    expect(mocks.replaceTranscript).not.toHaveBeenCalled();
    expect(mocks.markHistoryHydrated).toHaveBeenCalledWith('session-codex-recheck', 'none');

    await handler({
      ws: ws as never,
      sessionId: 'session-codex-recheck',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadCodexSessionHistory).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    await handler({
      ws: ws as never,
      sessionId: 'session-codex-recheck',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.loadCodexSessionHistory).toHaveBeenCalledTimes(2);
    expect(mocks.replaceTranscript).toHaveBeenCalledWith(
      'session-codex-recheck',
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agent',
          message: expect.objectContaining({
            type: 'stream_event',
            event: expect.objectContaining({
              content_block: expect.objectContaining({
                type: 'tool_use',
                id: 'call-missing',
                name: 'exec_command',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          source: 'agent',
          message: expect.objectContaining({
            type: 'user',
            message: expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'tool_result',
                  tool_use_id: 'call-missing',
                  content: 'martin',
                }),
              ]),
            }),
          }),
        }),
      ]),
      { historySource: 'jsonl' }
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

  it('emits cached Claude commands plus a fresh workspace command scan on passive load', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-slash-commands-'));
    tempDirs.push(worktreePath);
    const commandsDir = join(worktreePath, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(
      join(commandsDir, 'workspace-only.md'),
      '---\ndescription: Workspace only\n---\n'
    );
    writeFileSync(
      join(commandsDir, 'duplicate.md'),
      '---\ndescription: Workspace duplicate\n---\n'
    );

    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      model: 'claude-sonnet-4-5',
      workspace: { status: 'READY', worktreePath },
      providerSessionId: null,
      providerProjectPath: null,
    });
    mocks.getCachedCommands.mockResolvedValue([
      { name: '/global-only', description: 'Global only' },
      { name: '/project:duplicate', description: 'Cached duplicate' },
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
      workingDir: worktreePath,
      message: { type: 'load_session' } as never,
    });

    expect(mocks.emitDelta).toHaveBeenCalledWith('session-1', {
      type: 'slash_commands',
      slashCommands: [
        { name: '/global-only', description: 'Global only' },
        { name: '/project:duplicate', description: 'Cached duplicate' },
        { name: 'workspace-only', description: 'Workspace only' },
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
