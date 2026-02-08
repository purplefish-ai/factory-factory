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
});
