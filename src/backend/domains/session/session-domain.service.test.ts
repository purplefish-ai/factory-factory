import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@/backend/claude';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { chatConnectionService } from '@/backend/services/chat-connection.service';

vi.mock('@/backend/claude', async () => {
  const actual = await vi.importActual<typeof import('@/backend/claude')>('@/backend/claude');
  return {
    ...actual,
    SessionManager: {
      ...actual.SessionManager,
      getHistoryFromProjectPath: vi.fn(),
    },
  };
});

vi.mock('@/backend/services/chat-connection.service', () => ({
  chatConnectionService: {
    forwardToSession: vi.fn(),
    values: vi.fn(() => [][Symbol.iterator]()),
  },
}));

const mockedConnectionService = vi.mocked(chatConnectionService);

function getReplayBatches(): Array<{
  type?: string;
  loadRequestId?: string;
  replayEvents?: Record<string, unknown>[];
}> {
  return mockedConnectionService.forwardToSession.mock.calls
    .map(
      ([, payload]) =>
        payload as {
          type?: string;
          loadRequestId?: string;
          replayEvents?: Record<string, unknown>[];
        }
    )
    .filter((payload) => payload.type === 'session_replay_batch');
}

function getLatestReplayBatch(): {
  type?: string;
  loadRequestId?: string;
  replayEvents?: Record<string, unknown>[];
} {
  const latest = getReplayBatches().at(-1);
  if (!latest) {
    throw new Error('Expected at least one session_replay_batch payload');
  }
  return latest;
}

describe('SessionDomainService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionDomainService.clearAllSessions();
  });

  it('hydrates from Claude history on first subscribe and emits session_replay_batch', async () => {
    vi.mocked(SessionManager.getHistoryFromProjectPath).mockResolvedValue([
      {
        type: 'user',
        content: 'hello',
        timestamp: '2026-02-01T00:00:00.000Z',
      },
      {
        type: 'assistant',
        content: 'hi',
        timestamp: '2026-02-01T00:00:01.000Z',
      },
    ]);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
      loadRequestId: 'load-1',
    });

    expect(mockedConnectionService.forwardToSession).toHaveBeenCalledTimes(1);
    expect(mockedConnectionService.forwardToSession.mock.calls[0]?.[1]).toMatchObject({
      type: 'session_replay_batch',
    });

    expect(mockedConnectionService.forwardToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'session_replay_batch',
        loadRequestId: 'load-1',
      })
    );

    const payload = getLatestReplayBatch();
    const replayEvents = payload.replayEvents ?? [];
    expect(replayEvents.length).toBeGreaterThan(0);
    expect(replayEvents[0]).toMatchObject({
      type: 'session_runtime_snapshot',
    });
    expect(replayEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message_state_changed',
          newState: 'ACCEPTED',
          userMessage: expect.objectContaining({ text: 'hello' }),
        }),
        expect.objectContaining({
          type: 'claude_message',
          data: expect.objectContaining({
            type: 'assistant',
          }),
        }),
      ])
    );
  });

  it('hydrates user attachments from Claude history into snapshot messages', async () => {
    vi.mocked(SessionManager.getHistoryFromProjectPath).mockResolvedValue([
      {
        type: 'user',
        content: '',
        timestamp: '2026-02-01T00:00:00.000Z',
        attachments: [
          {
            id: 'att-1',
            name: 'image-1.png',
            type: 'image/png',
            size: 123,
            data: 'Zm9v',
            contentType: 'image',
          },
        ],
      },
    ]);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    const replayEvents = getLatestReplayBatch().replayEvents ?? [];
    const accepted = replayEvents.find(
      (event) =>
        event.type === 'message_state_changed' &&
        event.newState === 'ACCEPTED' &&
        (event.userMessage as { text?: string } | undefined)?.text === ''
    ) as { userMessage?: { attachments?: Array<{ id?: string }> } } | undefined;
    expect(accepted).toBeDefined();
    expect(accepted?.userMessage?.attachments?.[0]?.id).toBe('att-1');
  });

  it('preserves tool_result is_error flag when hydrating history', async () => {
    vi.mocked(SessionManager.getHistoryFromProjectPath).mockResolvedValue([
      {
        type: 'tool_result',
        content: 'Tool failed',
        toolId: 'tool-1',
        isError: true,
        timestamp: '2026-02-01T00:00:00.000Z',
      },
    ]);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    const replayEvents = getLatestReplayBatch().replayEvents ?? [];
    const claudeEvent = replayEvents.find(
      (event) =>
        event.type === 'claude_message' &&
        (event.data as { type?: string } | undefined)?.type === 'user'
    ) as
      | {
          data?: {
            type?: string;
            message?: { role?: string; content?: Array<{ type?: string; is_error?: boolean }> };
          };
        }
      | undefined;
    expect(claudeEvent).toBeDefined();
    expect(claudeEvent?.data?.type).toBe('user');
    expect(claudeEvent?.data?.message?.role).toBe('user');
    expect(claudeEvent?.data?.message?.content?.[0]).toMatchObject({
      type: 'tool_result',
      is_error: true,
    });
  });

  it('preserves structured tool_result content when hydrating history', async () => {
    const structuredContent = [
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png', data: 'Zm9vYmFy' },
      },
    ];

    vi.mocked(SessionManager.getHistoryFromProjectPath).mockResolvedValue([
      {
        type: 'tool_result',
        content: structuredContent,
        toolId: 'tool-2',
        timestamp: '2026-02-01T00:00:00.000Z',
      },
    ]);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    const replayEvents = getLatestReplayBatch().replayEvents ?? [];
    const claudeEvent = replayEvents.find(
      (event) =>
        event.type === 'claude_message' &&
        (event.data as { type?: string } | undefined)?.type === 'user'
    ) as
      | {
          data?: {
            message?: {
              content?: Array<{ type?: string; content?: unknown }>;
            };
          };
        }
      | undefined;

    expect(claudeEvent?.data?.message?.content?.[0]).toMatchObject({
      type: 'tool_result',
      content: structuredContent,
    });
  });

  it('subscribe does not emit session_delta before session_replay_batch', async () => {
    vi.mocked(SessionManager.getHistoryFromProjectPath).mockResolvedValue([]);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: null,
      sessionRuntime: {
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
        updatedAt: new Date().toISOString(),
      },
    });

    expect(mockedConnectionService.forwardToSession).toHaveBeenCalledTimes(1);
    const replayEvents = getLatestReplayBatch().replayEvents ?? [];
    expect(replayEvents[0]).toMatchObject({
      type: 'session_runtime_snapshot',
      sessionRuntime: expect.objectContaining({
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
      }),
    });
  });

  it('deduplicates concurrent hydration so history is loaded once', async () => {
    type HydratedHistory = Array<{ type: 'user'; content: string; timestamp: string }>;
    let resolveHistory!: (history: HydratedHistory) => void;
    const historyPromise = new Promise<HydratedHistory>((resolve) => {
      resolveHistory = resolve;
    });
    vi.mocked(SessionManager.getHistoryFromProjectPath).mockReturnValue(historyPromise);

    const firstSubscribe = sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });
    const secondSubscribe = sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    await Promise.resolve();
    expect(SessionManager.getHistoryFromProjectPath).toHaveBeenCalledTimes(1);

    resolveHistory([
      {
        type: 'user',
        content: 'hello from history',
        timestamp: '2026-02-01T00:00:00.000Z',
      },
    ]);
    await Promise.all([firstSubscribe, secondSubscribe]);

    const batches = getReplayBatches();
    expect(batches).toHaveLength(2);
    const latestEvents = batches.at(-1)?.replayEvents ?? [];
    const accepted = latestEvents.find(
      (event) =>
        event.type === 'message_state_changed' &&
        event.newState === 'ACCEPTED' &&
        (event.userMessage as { text?: string } | undefined)?.text === 'hello from history'
    );
    expect(accepted).toBeDefined();
  });

  it('rehydrates when claudeSessionId changes for the same db session', async () => {
    vi.mocked(SessionManager.getHistoryFromProjectPath)
      .mockResolvedValueOnce([
        {
          type: 'user',
          content: 'history one',
          timestamp: '2026-02-01T00:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          type: 'user',
          content: 'history two',
          timestamp: '2026-02-01T00:01:00.000Z',
        },
      ]);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s2',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    expect(SessionManager.getHistoryFromProjectPath).toHaveBeenCalledTimes(2);
    const latestEvents = getLatestReplayBatch().replayEvents ?? [];
    const accepted = latestEvents.find(
      (event) =>
        event.type === 'message_state_changed' &&
        event.newState === 'ACCEPTED' &&
        (event.userMessage as { text?: string } | undefined)?.text === 'history two'
    );
    expect(accepted).toBeDefined();
  });

  it('ignores stale in-flight hydrate results when a newer hydrate starts', async () => {
    type HydratedHistory = Array<{ type: 'user'; content: string; timestamp: string }>;
    let resolveFirst!: (history: HydratedHistory) => void;
    const firstHistoryPromise = new Promise<HydratedHistory>((resolve) => {
      resolveFirst = resolve;
    });

    vi.mocked(SessionManager.getHistoryFromProjectPath).mockImplementation((claudeSessionId) => {
      if (claudeSessionId === 'claude-s1') {
        return firstHistoryPromise;
      }
      return Promise.resolve([
        {
          type: 'user',
          content: 'new hydrate',
          timestamp: '2026-02-01T00:02:00.000Z',
        },
      ]);
    });

    const firstSubscribe = sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });
    const secondSubscribe = sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s2',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    await secondSubscribe;
    resolveFirst([
      {
        type: 'user',
        content: 'stale hydrate',
        timestamp: '2026-02-01T00:00:00.000Z',
      },
    ]);
    await firstSubscribe;

    const latestEvents = getLatestReplayBatch().replayEvents ?? [];
    const accepted = latestEvents.find(
      (event) =>
        event.type === 'message_state_changed' &&
        event.newState === 'ACCEPTED' &&
        (event.userMessage as { text?: string } | undefined)?.text === 'new hydrate'
    );
    expect(accepted).toBeDefined();
  });

  it('uses deterministic fallback IDs for history entries without uuid', async () => {
    const history = [
      {
        type: 'user' as const,
        content: 'hello',
        timestamp: '2026-02-01T00:00:00.000Z',
      },
      {
        type: 'assistant' as const,
        content: 'hi',
        timestamp: '2026-02-01T00:00:01.000Z',
      },
    ];
    vi.mocked(SessionManager.getHistoryFromProjectPath).mockResolvedValue(history);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    const firstEvents = getLatestReplayBatch().replayEvents ?? [];
    const firstIds = firstEvents
      .filter((event) => event.type === 'message_state_changed' && event.newState === 'ACCEPTED')
      .map((event) => event.id as string);

    mockedConnectionService.forwardToSession.mockClear();
    sessionDomainService.clearSession('s1');
    vi.mocked(SessionManager.getHistoryFromProjectPath).mockResolvedValue(history);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    const secondEvents = getLatestReplayBatch().replayEvents ?? [];
    const secondIds = secondEvents
      .filter((event) => event.type === 'message_state_changed' && event.newState === 'ACCEPTED')
      .map((event) => event.id as string);

    expect(secondIds).toEqual(firstIds);
  });

  it('rehydrates from JSONL after process exit and replaces stale in-memory transcript', async () => {
    vi.mocked(SessionManager.getHistoryFromProjectPath)
      .mockResolvedValueOnce([
        {
          type: 'user',
          content: 'stale transcript',
          timestamp: '2026-02-01T00:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          type: 'user',
          content: 'fresh transcript from jsonl',
          timestamp: '2026-02-01T00:10:00.000Z',
        },
      ]);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    sessionDomainService.markProcessExit('s1', 1);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    expect(SessionManager.getHistoryFromProjectPath).toHaveBeenCalledTimes(2);

    const latestSnapshot = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; messages?: Array<{ text?: string }> })
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);
    expect(latestSnapshot?.messages).toHaveLength(1);
    expect(latestSnapshot?.messages?.[0]?.text).toBe('fresh transcript from jsonl');
  });

  it('emits reset snapshot first, then hydrated snapshot on process exit', async () => {
    type HydratedHistory = Array<{ type: 'user'; content: string; timestamp: string }>;
    let resolveRehydrate!: (history: HydratedHistory) => void;
    const rehydratePromise = new Promise<HydratedHistory>((resolve) => {
      resolveRehydrate = resolve;
    });

    vi.mocked(SessionManager.getHistoryFromProjectPath)
      .mockResolvedValueOnce([
        {
          type: 'user',
          content: 'before exit',
          timestamp: '2026-02-01T00:00:00.000Z',
        },
      ])
      .mockReturnValueOnce(rehydratePromise);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: 'claude-s1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      },
    });

    mockedConnectionService.forwardToSession.mockClear();
    sessionDomainService.markProcessExit('s1', 1);

    const immediateSnapshots = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; messages?: unknown[] })
      .filter((payload) => payload.type === 'session_snapshot');
    expect(immediateSnapshots).toHaveLength(1);
    expect(immediateSnapshots[0]?.messages).toEqual([]);

    resolveRehydrate([
      {
        type: 'user',
        content: 'after exit',
        timestamp: '2026-02-01T00:05:00.000Z',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshotsAfterRehydrate = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; messages?: Array<{ text?: string }> })
      .filter((payload) => payload.type === 'session_snapshot');
    expect(snapshotsAfterRehydrate).toHaveLength(2);
    const latestSnapshot = snapshotsAfterRehydrate.at(-1);
    expect(latestSnapshot?.messages?.[0]?.text).toBe('after exit');
  });

  it('enqueue adds queued message and emits updated snapshot', () => {
    const result = sessionDomainService.enqueue('s1', {
      id: 'm1',
      text: 'queued',
      timestamp: '2026-02-01T00:00:00.000Z',
      settings: {
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    expect(result).toEqual({ position: 0 });

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls.find(
      ([, payload]) => (payload as { type?: string }).type === 'session_snapshot'
    );
    expect(snapshotCall).toBeDefined();
    const payload = snapshotCall?.[1] as {
      queuedMessages?: Array<{ id: string }>;
      messages?: Array<{ id: string }>;
    };
    expect(payload.queuedMessages?.map((msg) => msg.id)).toEqual(['m1']);
    expect(payload.messages?.some((msg) => msg.id === 'm1')).toBe(true);
  });

  it('dequeueNext emits snapshot by default', () => {
    sessionDomainService.enqueue('s1', {
      id: 'm1',
      text: 'queued',
      timestamp: '2026-02-01T00:00:00.000Z',
      settings: {
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    mockedConnectionService.forwardToSession.mockClear();
    const next = sessionDomainService.dequeueNext('s1');

    expect(next?.id).toBe('m1');
    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls.find(
      ([, payload]) => (payload as { type?: string }).type === 'session_snapshot'
    );
    expect(snapshotCall).toBeDefined();
  });

  it('dequeueNext can skip snapshot emission to avoid transient UI gaps during dispatch', () => {
    sessionDomainService.enqueue('s1', {
      id: 'm1',
      text: 'queued',
      timestamp: '2026-02-01T00:00:00.000Z',
      settings: {
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    mockedConnectionService.forwardToSession.mockClear();
    const next = sessionDomainService.dequeueNext('s1', { emitSnapshot: false });

    expect(next?.id).toBe('m1');
    expect(mockedConnectionService.forwardToSession).not.toHaveBeenCalled();
  });

  it('markProcessExit drops queued messages and pending interactive request', () => {
    sessionDomainService.enqueue('s1', {
      id: 'm1',
      text: 'queued',
      timestamp: '2026-02-01T00:00:00.000Z',
      settings: {
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    sessionDomainService.setPendingInteractiveRequest('s1', {
      requestId: 'req-1',
      toolName: 'ExitPlanMode',
      toolUseId: 'tool-1',
      input: { plan: 'x' },
      planContent: 'x',
      timestamp: '2026-02-01T00:00:00.000Z',
    });

    sessionDomainService.markProcessExit('s1', 1);

    expect(sessionDomainService.getQueueLength('s1')).toBe(0);
    expect(sessionDomainService.getPendingInteractiveRequest('s1')).toBeNull();

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls
      .filter(([, payload]) => (payload as { type?: string }).type === 'session_snapshot')
      .at(-1);
    expect(snapshotCall).toBeDefined();
    const payload = snapshotCall?.[1] as { queuedMessages?: unknown[] };
    expect(payload.queuedMessages).toEqual([]);
  });

  it('markProcessExit treats exit code 0 as expected and keeps idle phase', async () => {
    vi.mocked(SessionManager.getHistoryFromProjectPath).mockResolvedValue([]);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: null,
      sessionRuntime: {
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
        updatedAt: new Date().toISOString(),
      },
    });

    sessionDomainService.markProcessExit('s1', 0);

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; sessionRuntime?: unknown })
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);
    expect(snapshotCall).toBeDefined();
    expect(snapshotCall?.sessionRuntime).toMatchObject({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      lastExit: {
        code: 0,
        unexpected: false,
      },
    });
  });

  it('markProcessExit treats null exit code as unexpected and sets error phase', async () => {
    vi.mocked(SessionManager.getHistoryFromProjectPath).mockResolvedValue([]);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: null,
      sessionRuntime: {
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
        updatedAt: new Date().toISOString(),
      },
    });

    sessionDomainService.markProcessExit('s1', null);

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; sessionRuntime?: unknown })
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);
    expect(snapshotCall).toBeDefined();
    expect(snapshotCall?.sessionRuntime).toMatchObject({
      phase: 'error',
      processState: 'stopped',
      activity: 'IDLE',
      lastExit: {
        code: null,
        unexpected: true,
      },
    });
  });

  it('clears stale lastExit after transitioning back to idle', async () => {
    vi.mocked(SessionManager.getHistoryFromProjectPath).mockResolvedValue([]);

    await sessionDomainService.subscribe({
      sessionId: 's1',
      claudeProjectPath: '/tmp/project-path',
      claudeSessionId: null,
      sessionRuntime: {
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
        updatedAt: new Date().toISOString(),
      },
    });

    sessionDomainService.markProcessExit('s1', 1);
    sessionDomainService.markIdle('s1', 'alive');
    sessionDomainService.emitSessionSnapshot('s1');

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; sessionRuntime?: { lastExit?: unknown } })
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);
    expect(snapshotCall).toBeDefined();
    expect(snapshotCall?.sessionRuntime).toBeDefined();
    expect(snapshotCall?.sessionRuntime?.lastExit).toBeUndefined();
  });

  it('does not persist duplicate result text when latest assistant text matches', () => {
    sessionDomainService.appendClaudeEvent('s1', {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'There are **514 TypeScript files**.' }],
      },
      timestamp: '2026-02-08T00:00:00.000Z',
    });

    sessionDomainService.appendClaudeEvent('s1', {
      type: 'result',
      result: 'There are **514 TypeScript files**.',
      timestamp: '2026-02-08T00:00:01.000Z',
    });

    sessionDomainService.emitSessionSnapshot('s1');

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; messages?: Array<{ source: string }> })
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);
    expect(snapshotCall?.messages).toHaveLength(1);
    expect(snapshotCall?.messages?.[0]?.source).toBe('claude');
  });

  it('does not consume order for filtered non-persisted events', () => {
    const filteredOrder = sessionDomainService.appendClaudeEvent('s1', {
      type: 'stream_event',
      event: { type: 'message_start', message: { role: 'assistant', content: [] } },
      timestamp: '2026-02-08T00:00:00.000Z',
    });
    const persistedOrder = sessionDomainService.appendClaudeEvent('s1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      timestamp: '2026-02-08T00:00:01.000Z',
    });

    expect(filteredOrder).toBe(0);
    expect(persistedOrder).toBe(1);
  });

  it('does not consume order for duplicate result suppression', () => {
    const assistantOrder = sessionDomainService.appendClaudeEvent('s1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'same text' }] },
      timestamp: '2026-02-08T00:00:00.000Z',
    });
    const duplicateResultOrder = sessionDomainService.appendClaudeEvent('s1', {
      type: 'result',
      result: 'same text',
      timestamp: '2026-02-08T00:00:01.000Z',
    });
    const nextAssistantOrder = sessionDomainService.appendClaudeEvent('s1', {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
      },
      timestamp: '2026-02-08T00:00:02.000Z',
    });

    expect(assistantOrder).toBe(0);
    expect(duplicateResultOrder).toBe(1);
    expect(nextAssistantOrder).toBe(2);
  });

  it('suppresses duplicate result when payload is structured object text', () => {
    sessionDomainService.appendClaudeEvent('s1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'structured answer' }] },
      timestamp: '2026-02-08T00:00:00.000Z',
    });

    const duplicateResultOrder = sessionDomainService.appendClaudeEvent('s1', {
      type: 'result',
      result: { text: 'structured answer' },
      timestamp: '2026-02-08T00:00:01.000Z',
    });

    sessionDomainService.emitSessionSnapshot('s1');

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; messages?: Array<{ source: string }> })
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);
    expect(duplicateResultOrder).toBe(1);
    expect(snapshotCall?.messages).toHaveLength(1);
    expect(snapshotCall?.messages?.[0]?.source).toBe('claude');
  });

  it('keeps result when matching text exists only in a previous turn', () => {
    sessionDomainService.commitSentUserMessage('s1', {
      id: 'u1',
      text: 'first question',
      timestamp: '2026-02-08T00:00:00.000Z',
      settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
    });
    sessionDomainService.appendClaudeEvent('s1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Same answer' }] },
      timestamp: '2026-02-08T00:00:01.000Z',
    });

    sessionDomainService.commitSentUserMessage('s1', {
      id: 'u2',
      text: 'second question',
      timestamp: '2026-02-08T00:00:02.000Z',
      settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
    });
    sessionDomainService.appendClaudeEvent('s1', {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }],
      },
      timestamp: '2026-02-08T00:00:03.000Z',
    });
    sessionDomainService.appendClaudeEvent('s1', {
      type: 'result',
      result: 'Same answer',
      timestamp: '2026-02-08T00:00:04.000Z',
    });

    sessionDomainService.emitSessionSnapshot('s1');

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls
      .map(
        ([, payload]) =>
          payload as {
            type?: string;
            messages?: Array<{ source: string; message?: { type?: string } }>;
          }
      )
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);

    expect(snapshotCall?.messages).toHaveLength(5);
    expect(snapshotCall?.messages?.[4]).toMatchObject({
      source: 'claude',
      message: { type: 'result' },
    });
  });

  it('does not persist non-renderable stream events in transcript snapshots', () => {
    sessionDomainService.appendClaudeEvent('s1', {
      type: 'stream_event',
      event: { type: 'message_start', message: { role: 'assistant', content: [] } },
      timestamp: '2026-02-08T00:00:00.000Z',
    });

    sessionDomainService.appendClaudeEvent('s1', {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
      },
      timestamp: '2026-02-08T00:00:01.000Z',
    });

    sessionDomainService.emitSessionSnapshot('s1');

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls
      .map(
        ([, payload]) =>
          payload as {
            type?: string;
            messages?: Array<{ message?: { type?: string; event?: { type?: string } } }>;
          }
      )
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);

    expect(snapshotCall?.messages).toHaveLength(1);
    expect(snapshotCall?.messages?.[0]?.message?.type).toBe('stream_event');
    expect(snapshotCall?.messages?.[0]?.message?.event?.type).toBe('content_block_start');
  });
});
