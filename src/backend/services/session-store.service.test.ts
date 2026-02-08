import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../claude';
import { chatConnectionService } from './chat-connection.service';
import { sessionStoreService } from './session-store.service';

vi.mock('../claude', async () => {
  const actual = await vi.importActual<typeof import('../claude')>('../claude');
  return {
    ...actual,
    SessionManager: {
      ...actual.SessionManager,
      getHistory: vi.fn(),
    },
  };
});

vi.mock('./chat-connection.service', () => ({
  chatConnectionService: {
    forwardToSession: vi.fn(),
    values: vi.fn(() => [][Symbol.iterator]()),
  },
}));

const mockedConnectionService = vi.mocked(chatConnectionService);

describe('SessionStoreService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStoreService.clearAllSessions();
  });

  it('hydrates from Claude history on first subscribe and emits session_snapshot', async () => {
    vi.mocked(SessionManager.getHistory).mockResolvedValue([
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

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: 'claude-s1',
      isRunning: false,
      isWorking: false,
      loadRequestId: 'load-1',
    });

    expect(mockedConnectionService.forwardToSession).toHaveBeenCalledTimes(1);
    expect(mockedConnectionService.forwardToSession.mock.calls[0]?.[1]).toMatchObject({
      type: 'session_snapshot',
    });

    expect(mockedConnectionService.forwardToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'session_snapshot',
        loadRequestId: 'load-1',
      })
    );

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls.find(
      ([, payload]) => (payload as { type?: string }).type === 'session_snapshot'
    );
    expect(snapshotCall).toBeDefined();
    const payload = snapshotCall?.[1] as { messages?: Array<{ text?: string }> };
    expect(payload.messages?.length).toBe(2);
    expect(payload.messages?.[0]?.text).toBe('hello');
  });

  it('hydrates user attachments from Claude history into snapshot messages', async () => {
    vi.mocked(SessionManager.getHistory).mockResolvedValue([
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

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: 'claude-s1',
      isRunning: false,
      isWorking: false,
    });

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls.find(
      ([, payload]) => (payload as { type?: string }).type === 'session_snapshot'
    );
    expect(snapshotCall).toBeDefined();
    const payload = snapshotCall?.[1] as {
      messages?: Array<{ source: string; attachments?: Array<{ id: string }> }>;
    };
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages?.[0]?.source).toBe('user');
    expect(payload.messages?.[0]?.attachments?.[0]?.id).toBe('att-1');
  });

  it('preserves tool_result is_error flag when hydrating history', async () => {
    vi.mocked(SessionManager.getHistory).mockResolvedValue([
      {
        type: 'tool_result',
        content: 'Tool failed',
        toolId: 'tool-1',
        isError: true,
        timestamp: '2026-02-01T00:00:00.000Z',
      },
    ]);

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: 'claude-s1',
      isRunning: false,
      isWorking: false,
    });

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls.find(
      ([, payload]) => (payload as { type?: string }).type === 'session_snapshot'
    );
    expect(snapshotCall).toBeDefined();
    const payload = snapshotCall?.[1] as {
      messages?: Array<{
        source: string;
        message?: {
          type?: string;
          message?: {
            role?: string;
            content?: Array<{ type?: string; is_error?: boolean }>;
          };
        };
      }>;
    };
    const claudeMessage = payload.messages?.find((msg) => msg.source === 'claude')?.message;
    expect(claudeMessage?.type).toBe('user');
    expect(claudeMessage?.message?.role).toBe('user');
    expect(claudeMessage?.message?.content?.[0]).toMatchObject({
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

    vi.mocked(SessionManager.getHistory).mockResolvedValue([
      {
        type: 'tool_result',
        content: structuredContent,
        toolId: 'tool-2',
        timestamp: '2026-02-01T00:00:00.000Z',
      },
    ]);

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: 'claude-s1',
      isRunning: false,
      isWorking: false,
    });

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls.find(
      ([, payload]) => (payload as { type?: string }).type === 'session_snapshot'
    );
    expect(snapshotCall).toBeDefined();
    const payload = snapshotCall?.[1] as {
      messages?: Array<{
        source: string;
        message?: {
          type?: string;
          message?: {
            role?: string;
            content?: Array<{ type?: string; content?: unknown }>;
          };
        };
      }>;
    };

    const claudeMessage = payload.messages?.find((msg) => msg.source === 'claude')?.message;
    expect(claudeMessage?.type).toBe('user');
    expect(claudeMessage?.message?.content?.[0]).toMatchObject({
      type: 'tool_result',
      content: structuredContent,
    });
  });

  it('subscribe does not emit session_delta before session_snapshot', async () => {
    vi.mocked(SessionManager.getHistory).mockResolvedValue([]);

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: null,
      isRunning: true,
      isWorking: true,
    });

    expect(mockedConnectionService.forwardToSession).toHaveBeenCalledTimes(1);
    expect(mockedConnectionService.forwardToSession.mock.calls[0]?.[1]).toMatchObject({
      type: 'session_snapshot',
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
    vi.mocked(SessionManager.getHistory).mockReturnValue(historyPromise);

    const firstSubscribe = sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: 'claude-s1',
      isRunning: false,
      isWorking: false,
    });
    const secondSubscribe = sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: 'claude-s1',
      isRunning: false,
      isWorking: false,
    });

    await Promise.resolve();
    expect(SessionManager.getHistory).toHaveBeenCalledTimes(1);

    resolveHistory([
      {
        type: 'user',
        content: 'hello from history',
        timestamp: '2026-02-01T00:00:00.000Z',
      },
    ]);
    await Promise.all([firstSubscribe, secondSubscribe]);

    const snapshots = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; messages?: Array<{ text?: string }> })
      .filter((payload) => payload.type === 'session_snapshot');
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)?.messages?.[0]?.text).toBe('hello from history');
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
    vi.mocked(SessionManager.getHistory).mockResolvedValue(history);

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: 'claude-s1',
      isRunning: false,
      isWorking: false,
    });

    const firstSnapshot = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; messages?: Array<{ id: string }> })
      .find((payload) => payload.type === 'session_snapshot');
    expect(firstSnapshot?.messages).toBeDefined();
    const firstIds = firstSnapshot?.messages?.map((m) => m.id) ?? [];

    mockedConnectionService.forwardToSession.mockClear();
    sessionStoreService.clearSession('s1');
    vi.mocked(SessionManager.getHistory).mockResolvedValue(history);

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: 'claude-s1',
      isRunning: false,
      isWorking: false,
    });

    const secondSnapshot = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; messages?: Array<{ id: string }> })
      .find((payload) => payload.type === 'session_snapshot');
    const secondIds = secondSnapshot?.messages?.map((m) => m.id) ?? [];

    expect(secondIds).toEqual(firstIds);
  });

  it('rehydrates from JSONL after process exit and replaces stale in-memory transcript', async () => {
    vi.mocked(SessionManager.getHistory)
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

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: 'claude-s1',
      isRunning: false,
      isWorking: false,
    });

    sessionStoreService.markProcessExit('s1', 1);

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: 'claude-s1',
      isRunning: false,
      isWorking: false,
    });

    expect(SessionManager.getHistory).toHaveBeenCalledTimes(2);

    const latestSnapshot = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; messages?: Array<{ text?: string }> })
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);
    expect(latestSnapshot?.messages).toHaveLength(1);
    expect(latestSnapshot?.messages?.[0]?.text).toBe('fresh transcript from jsonl');
  });

  it('enqueue adds queued message and emits updated snapshot', () => {
    const result = sessionStoreService.enqueue('s1', {
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
    sessionStoreService.enqueue('s1', {
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
    const next = sessionStoreService.dequeueNext('s1');

    expect(next?.id).toBe('m1');
    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls.find(
      ([, payload]) => (payload as { type?: string }).type === 'session_snapshot'
    );
    expect(snapshotCall).toBeDefined();
  });

  it('dequeueNext can skip snapshot emission to avoid transient UI gaps during dispatch', () => {
    sessionStoreService.enqueue('s1', {
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
    const next = sessionStoreService.dequeueNext('s1', { emitSnapshot: false });

    expect(next?.id).toBe('m1');
    expect(mockedConnectionService.forwardToSession).not.toHaveBeenCalled();
  });

  it('markProcessExit drops queued messages and pending interactive request', () => {
    sessionStoreService.enqueue('s1', {
      id: 'm1',
      text: 'queued',
      timestamp: '2026-02-01T00:00:00.000Z',
      settings: {
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    sessionStoreService.setPendingInteractiveRequest('s1', {
      requestId: 'req-1',
      toolName: 'ExitPlanMode',
      toolUseId: 'tool-1',
      input: { plan: 'x' },
      planContent: 'x',
      timestamp: '2026-02-01T00:00:00.000Z',
    });

    sessionStoreService.markProcessExit('s1', 1);

    expect(sessionStoreService.getQueueLength('s1')).toBe(0);
    expect(sessionStoreService.getPendingInteractiveRequest('s1')).toBeNull();

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls
      .filter(([, payload]) => (payload as { type?: string }).type === 'session_snapshot')
      .at(-1);
    expect(snapshotCall).toBeDefined();
    const payload = snapshotCall?.[1] as { queuedMessages?: unknown[] };
    expect(payload.queuedMessages).toEqual([]);
  });

  it('markProcessExit treats exit code 0 as expected and keeps idle phase', async () => {
    vi.mocked(SessionManager.getHistory).mockResolvedValue([]);

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: null,
      isRunning: true,
      isWorking: true,
    });

    sessionStoreService.markProcessExit('s1', 0);

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
    vi.mocked(SessionManager.getHistory).mockResolvedValue([]);

    await sessionStoreService.subscribe({
      sessionId: 's1',
      workingDir: '/tmp',
      claudeSessionId: null,
      isRunning: true,
      isWorking: true,
    });

    sessionStoreService.markProcessExit('s1', null);

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

  it('does not persist duplicate result text when latest assistant text matches', () => {
    sessionStoreService.appendClaudeEvent('s1', {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'There are **514 TypeScript files**.' }],
      },
      timestamp: '2026-02-08T00:00:00.000Z',
    });

    sessionStoreService.appendClaudeEvent('s1', {
      type: 'result',
      result: 'There are **514 TypeScript files**.',
      timestamp: '2026-02-08T00:00:01.000Z',
    });

    sessionStoreService.emitSessionSnapshot('s1');

    const snapshotCall = mockedConnectionService.forwardToSession.mock.calls
      .map(([, payload]) => payload as { type?: string; messages?: Array<{ source: string }> })
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);
    expect(snapshotCall?.messages).toHaveLength(1);
    expect(snapshotCall?.messages?.[0]?.source).toBe('claude');
  });

  it('keeps result when matching text exists only in a previous turn', () => {
    sessionStoreService.commitSentUserMessage('s1', {
      id: 'u1',
      text: 'first question',
      timestamp: '2026-02-08T00:00:00.000Z',
      settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
    });
    sessionStoreService.appendClaudeEvent('s1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Same answer' }] },
      timestamp: '2026-02-08T00:00:01.000Z',
    });

    sessionStoreService.commitSentUserMessage('s1', {
      id: 'u2',
      text: 'second question',
      timestamp: '2026-02-08T00:00:02.000Z',
      settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
    });
    sessionStoreService.appendClaudeEvent('s1', {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }],
      },
      timestamp: '2026-02-08T00:00:03.000Z',
    });
    sessionStoreService.appendClaudeEvent('s1', {
      type: 'result',
      result: 'Same answer',
      timestamp: '2026-02-08T00:00:04.000Z',
    });

    sessionStoreService.emitSessionSnapshot('s1');

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
    sessionStoreService.appendClaudeEvent('s1', {
      type: 'stream_event',
      event: { type: 'message_start', message: { role: 'assistant', content: [] } },
      timestamp: '2026-02-08T00:00:00.000Z',
    });

    sessionStoreService.appendClaudeEvent('s1', {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
      },
      timestamp: '2026-02-08T00:00:01.000Z',
    });

    sessionStoreService.emitSessionSnapshot('s1');

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
