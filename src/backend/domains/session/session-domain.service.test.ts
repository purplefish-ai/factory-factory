import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatConnectionService } from '@/backend/domains/session/chat/chat-connection.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';

vi.mock('@/backend/domains/session/chat/chat-connection.service', () => ({
  chatConnectionService: {
    forwardToSession: vi.fn(),
    values: vi.fn(() => [][Symbol.iterator]()),
  },
}));

const mockedConnectionService = vi.mocked(chatConnectionService);

function getLatestReplayBatch(): {
  type?: string;
  loadRequestId?: string;
  replayEvents?: Record<string, unknown>[];
} {
  const latest = mockedConnectionService.forwardToSession.mock.calls
    .map(
      ([, payload]) =>
        payload as {
          type?: string;
          loadRequestId?: string;
          replayEvents?: Record<string, unknown>[];
        }
    )
    .filter((payload) => payload.type === 'session_replay_batch')
    .at(-1);

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

  it('subscribes and emits replay plus runtime delta', async () => {
    await sessionDomainService.subscribe({
      sessionId: 's1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: '2026-02-14T00:00:00.000Z',
      },
      loadRequestId: 'load-1',
    });

    expect(mockedConnectionService.forwardToSession).toHaveBeenCalledTimes(2);
    expect(mockedConnectionService.forwardToSession.mock.calls[0]?.[1]).toMatchObject({
      type: 'session_replay_batch',
      loadRequestId: 'load-1',
    });
    expect(mockedConnectionService.forwardToSession.mock.calls[1]?.[1]).toMatchObject({
      type: 'session_delta',
      data: expect.objectContaining({ type: 'session_runtime_updated' }),
    });
  });

  it('includes queued message and committed user message in replay', async () => {
    sessionDomainService.enqueue('s1', {
      id: 'q1',
      text: 'queued',
      timestamp: '2026-02-14T00:00:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    sessionDomainService.commitSentUserMessage('s1', {
      id: 'u1',
      text: 'hello',
      timestamp: '2026-02-14T00:00:01.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    await sessionDomainService.subscribe({
      sessionId: 's1',
      sessionRuntime: {
        phase: 'idle',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: '2026-02-14T00:00:02.000Z',
      },
    });

    const replayEvents = getLatestReplayBatch().replayEvents ?? [];
    expect(replayEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message_state_changed',
          id: 'u1',
          newState: 'COMMITTED',
        }),
        expect.objectContaining({
          type: 'message_state_changed',
          id: 'q1',
          newState: 'ACCEPTED',
        }),
      ])
    );
  });

  it('markProcessExit clears queue but preserves transcript for reload', () => {
    sessionDomainService.enqueue('s1', {
      id: 'q1',
      text: 'queued',
      timestamp: '2026-02-14T00:00:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    sessionDomainService.injectCommittedUserMessage('s1', 'before-exit');
    sessionDomainService.markProcessExit('s1', 1);

    const latestSnapshotPayload = mockedConnectionService.forwardToSession.mock.calls
      .map(
        ([, payload]) =>
          payload as { type?: string; sessionRuntime?: { phase?: string }; messages?: unknown[] }
      )
      .filter((payload) => payload.type === 'session_snapshot')
      .at(-1);

    expect(latestSnapshotPayload).toBeDefined();
    expect(latestSnapshotPayload).toMatchObject({
      type: 'session_snapshot',
      sessionRuntime: expect.objectContaining({
        phase: 'error',
        processState: 'stopped',
        activity: 'IDLE',
      }),
      messages: [expect.objectContaining({ source: 'user', text: 'before-exit' })],
    });
  });

  it('returns transcript snapshot sorted by order', () => {
    sessionDomainService.commitSentUserMessageAtOrder(
      's1',
      {
        id: 'u2',
        text: 'second',
        timestamp: '2026-02-14T00:00:01.000Z',
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      },
      2
    );

    sessionDomainService.commitSentUserMessageAtOrder(
      's1',
      {
        id: 'u1',
        text: 'first',
        timestamp: '2026-02-14T00:00:00.000Z',
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      },
      1
    );

    const snapshot = sessionDomainService.getTranscriptSnapshot('s1');
    expect(snapshot.map((entry) => entry.id)).toEqual(['u1', 'u2']);
  });

  it('removes transcript entries by message id', () => {
    sessionDomainService.commitSentUserMessage('s1', {
      id: 'u1',
      text: 'hello',
      timestamp: '2026-02-14T00:00:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });

    mockedConnectionService.forwardToSession.mockClear();
    const removed = sessionDomainService.removeTranscriptMessageById('s1', 'u1');

    expect(removed).toBe(true);
    expect(sessionDomainService.getTranscriptSnapshot('s1')).toEqual([]);
    expect(mockedConnectionService.forwardToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'session_snapshot',
        messages: [],
      })
    );
  });
});

describe('SessionDomainService additional behavior', () => {
  const queuedMessage = (id: string, text: string, timestamp = '2026-02-14T00:00:00.000Z') => ({
    id,
    text,
    timestamp,
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sessionDomainService.clearAllSessions();
  });

  it('stores and consumes initial messages once', () => {
    sessionDomainService.storeInitialMessage('s1', 'hello');

    expect(sessionDomainService.consumeInitialMessage('s1')).toBe('hello');
    expect(sessionDomainService.consumeInitialMessage('s1')).toBeNull();
  });

  it('supports queue operations and manual snapshots', () => {
    sessionDomainService.enqueue('s1', queuedMessage('q1', 'first'));
    sessionDomainService.enqueue('s1', queuedMessage('q2', 'second'));

    expect(sessionDomainService.getQueueLength('s1')).toBe(2);
    expect(sessionDomainService.peekNextMessage('s1')).toMatchObject({ id: 'q1' });

    const dequeued = sessionDomainService.dequeueNext('s1');
    expect(dequeued).toMatchObject({ id: 'q1' });

    sessionDomainService.requeueFront('s1', queuedMessage('q3', 'third'));
    expect(sessionDomainService.peekNextMessage('s1')).toMatchObject({ id: 'q3' });

    expect(sessionDomainService.removeQueuedMessage('s1', 'q2')).toBe(true);
    expect(sessionDomainService.removeQueuedMessage('s1', 'missing')).toBe(false);

    sessionDomainService.emitSessionSnapshot('s1', 'load-2');
    expect(mockedConnectionService.forwardToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'session_snapshot',
        loadRequestId: 'load-2',
      })
    );

    sessionDomainService.clearQueuedWork('s1');
    expect(sessionDomainService.getQueueLength('s1')).toBe(0);
  });

  it('tracks and clears pending interactive requests with event emission', () => {
    const listener = vi.fn();
    sessionDomainService.on('pending_request_changed', listener);

    sessionDomainService.setPendingInteractiveRequest('s1', {
      requestId: 'r1',
      toolName: 'AskUserQuestion',
      toolUseId: 'tu1',
      input: { question: 'continue?' },
      planContent: null,
      timestamp: '2026-02-14T00:00:00.000Z',
    });
    expect(sessionDomainService.getPendingInteractiveRequest('s1')).toMatchObject({
      requestId: 'r1',
    });

    sessionDomainService.clearPendingInteractiveRequestIfMatches('s1', 'wrong-id');
    expect(sessionDomainService.getPendingInteractiveRequest('s1')).toMatchObject({
      requestId: 'r1',
    });

    sessionDomainService.clearPendingInteractiveRequestIfMatches('s1', 'r1');
    expect(sessionDomainService.getPendingInteractiveRequest('s1')).toBeNull();

    sessionDomainService.setPendingInteractiveRequest('s1', {
      requestId: 'r2',
      toolName: 'ExitPlanMode',
      toolUseId: 'tu2',
      input: { plan: 'abc' },
      planContent: 'abc',
      timestamp: '2026-02-14T00:00:01.000Z',
    });
    sessionDomainService.clearPendingInteractiveRequest('s1');

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', hasPending: true })
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', hasPending: false })
    );
  });

  it('updates runtime state transitions and transcript hydration markers', () => {
    sessionDomainService.markStarting('s1');
    expect(sessionDomainService.getRuntimeSnapshot('s1')).toMatchObject({
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
    });

    sessionDomainService.markRunning('s1');
    sessionDomainService.markIdle('s1', 'alive');
    sessionDomainService.markStopping('s1');
    sessionDomainService.markError('s1');
    expect(sessionDomainService.getRuntimeSnapshot('s1').phase).toBe('error');

    expect(sessionDomainService.isHistoryHydrated('s1')).toBe(false);
    sessionDomainService.markHistoryHydrated('s1', 'jsonl');
    expect(sessionDomainService.isHistoryHydrated('s1')).toBe(true);

    sessionDomainService.replaceTranscript(
      's1',
      [
        {
          id: 'm2',
          source: 'user',
          text: 'second',
          timestamp: '2026-02-14T00:00:02.000Z',
          order: 2,
        },
        {
          id: 'm1',
          source: 'user',
          text: 'first',
          timestamp: '2026-02-14T00:00:01.000Z',
          order: 1,
        },
      ] as never,
      { historySource: 'acp_fallback' }
    );

    expect(sessionDomainService.getTranscriptSnapshot('s1').map((m) => m.id)).toEqual(['m1', 'm2']);

    const order = sessionDomainService.allocateOrder('s1');
    sessionDomainService.upsertClaudeEvent(
      's1',
      {
        type: 'assistant_message',
        text: 'agent message',
        timestamp: '2026-02-14T00:00:03.000Z',
      } as never,
      order
    );

    expect(sessionDomainService.getTranscriptSnapshot('s1').length).toBe(3);
  });
});
