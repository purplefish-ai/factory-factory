import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';

// Global test setup restores all mocks after each test, so the spy must be
// re-created per test.
let publishToSessionMock: ReturnType<typeof spyOnPublishToSession>;

function spyOnPublishToSession() {
  return vi.spyOn(sessionEventBus, 'publishToSession').mockImplementation(() => undefined);
}

beforeEach(() => {
  publishToSessionMock = spyOnPublishToSession();
});

function getLatestReplayBatch(): {
  type?: string;
  loadRequestId?: string;
  replayEvents?: Record<string, unknown>[];
} {
  const latest = publishToSessionMock.mock.calls
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

  it('upserts a lifecycle message once by its stable ID', () => {
    const lifecycleMessage = {
      id: 'session-lifecycle:event-1',
      source: 'agent' as const,
      timestamp: '2026-07-30T12:22:23.353Z',
      order: 0,
      message: {
        type: 'session_lifecycle' as const,
        lifecycle: {
          eventId: 'event-1',
          kind: 'TURN_INTERRUPTED' as const,
          reason: 'PROMPT_TIMEOUT' as const,
          message: 'Turn stopped: reached the 4-hour limit.',
          timestamp: '2026-07-30T12:22:23.353Z',
        },
      },
    };

    expect(sessionDomainService.upsertLifecycleMessage('s1', lifecycleMessage)).toBe(true);
    expect(sessionDomainService.upsertLifecycleMessage('s1', lifecycleMessage)).toBe(false);
    expect(sessionDomainService.getTranscriptSnapshot('s1')).toEqual([lifecycleMessage]);
  });

  it('chronologically reorders a lifecycle message that collides with provider order', () => {
    const providerMessage = {
      id: 'provider-at-noon',
      source: 'agent' as const,
      timestamp: '2026-07-30T12:00:00.000Z',
      order: 0,
      message: {
        type: 'assistant' as const,
        message: { role: 'assistant' as const, content: 'Provider message' },
      },
    };
    const lifecycleMessage = {
      id: 'session-lifecycle:event-at-eleven',
      source: 'agent' as const,
      timestamp: '2026-07-30T11:00:00.000Z',
      order: 0,
      message: {
        type: 'session_lifecycle' as const,
        lifecycle: {
          eventId: 'event-at-eleven',
          kind: 'TURN_INTERRUPTED' as const,
          reason: 'PROMPT_TIMEOUT' as const,
          message: 'Turn stopped before noon.',
          timestamp: '2026-07-30T11:00:00.000Z',
        },
      },
    };
    sessionDomainService.replaceTranscript('s1', [providerMessage]);

    expect(sessionDomainService.upsertLifecycleMessage('s1', lifecycleMessage)).toBe(true);
    expect(sessionDomainService.getTranscriptSnapshot('s1').map((message) => message.id)).toEqual([
      'session-lifecycle:event-at-eleven',
      'provider-at-noon',
    ]);
    expect(
      sessionDomainService.getTranscriptSnapshot('s1').map((message) => message.order)
    ).toEqual([0, 1]);
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

    expect(publishToSessionMock).toHaveBeenCalledTimes(2);
    expect(publishToSessionMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'session_replay_batch',
      loadRequestId: 'load-1',
    });
    expect(publishToSessionMock.mock.calls[1]?.[1]).toMatchObject({
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

  it('includes recent rejected message states in reconnect replay', async () => {
    sessionDomainService.rejectMessage('s1', 'rejected-1', 'Attachment is too large');

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
          id: 'rejected-1',
          newState: 'REJECTED',
          errorMessage: 'Attachment is too large',
        }),
      ])
    );
  });

  it('includes failed message recovery content in reconnect replay', async () => {
    const attachment = {
      id: 'attachment-1',
      name: 'notes.txt',
      type: 'text/plain',
      size: 11,
      data: 'draft notes',
      contentType: 'text' as const,
    };
    sessionDomainService.failMessage(
      's1',
      {
        id: 'failed-1',
        text: 'retry this draft',
        timestamp: '2026-02-14T00:00:00.000Z',
        attachments: [attachment],
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      },
      'code -32603: Internal error'
    );

    await sessionDomainService.subscribe({
      sessionId: 's1',
      sessionRuntime: {
        phase: 'error',
        processState: 'alive',
        activity: 'WORKING',
        errorMessage: 'code -32603: Internal error',
        updatedAt: '2026-02-14T00:00:02.000Z',
      },
    });

    const replayEvents = getLatestReplayBatch().replayEvents ?? [];
    expect(replayEvents).toEqual(
      expect.arrayContaining([
        {
          type: 'message_state_changed',
          id: 'failed-1',
          newState: 'FAILED',
          errorMessage: 'code -32603: Internal error',
          userMessage: {
            text: 'retry this draft',
            timestamp: '2026-02-14T00:00:00.000Z',
            attachments: [attachment],
            sessionId: 's1',
          },
        },
      ])
    );
  });

  it('replays failed message recovery content after preserving session cleanup', async () => {
    const attachment = {
      id: 'attachment-after-crash',
      name: 'crash-notes.txt',
      type: 'text/plain',
      size: 19,
      data: 'recover attachment',
      contentType: 'text' as const,
    };
    sessionDomainService.storeInitialMessage('s1', 'discard initial message');
    sessionDomainService.enqueue('s1', {
      id: 'queued-before-cleanup',
      text: 'discard queued message',
      timestamp: '2026-07-29T11:59:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    sessionDomainService.failMessage(
      's1',
      {
        id: 'failed-after-crash',
        text: 'recover this draft',
        timestamp: '2026-07-29T12:00:00.000Z',
        attachments: [attachment],
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      },
      'runtime crashed'
    );

    sessionDomainService.clearSession('s1', { preserveRejections: true });

    expect(sessionDomainService.getQueueLength('s1')).toBe(0);
    expect(sessionDomainService.consumeInitialMessage('s1')).toBeNull();

    await sessionDomainService.subscribe({
      sessionId: 's1',
      sessionRuntime: {
        phase: 'error',
        processState: 'stopped',
        activity: 'IDLE',
        errorMessage: 'runtime crashed',
        updatedAt: '2026-07-29T12:00:01.000Z',
      },
    });

    expect(getLatestReplayBatch().replayEvents).toEqual(
      expect.arrayContaining([
        {
          type: 'message_state_changed',
          id: 'failed-after-crash',
          newState: 'FAILED',
          errorMessage: 'runtime crashed',
          userMessage: {
            text: 'recover this draft',
            timestamp: '2026-07-29T12:00:00.000Z',
            attachments: [attachment],
            sessionId: 's1',
          },
        },
      ])
    );
  });

  it('markProcessExit clears queue but preserves transcript for reload', () => {
    const listener = vi.fn();
    sessionDomainService.on('pending_request_changed', listener);

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

    sessionDomainService.setPendingInteractiveRequest('s1', {
      requestId: 'r1',
      toolName: 'AskUserQuestion',
      toolUseId: 'tu1',
      input: { question: 'continue?' },
      planContent: null,
      timestamp: '2026-02-14T00:00:00.000Z',
    });
    listener.mockClear();

    sessionDomainService.injectCommittedUserMessage('s1', 'before-exit');
    sessionDomainService.markProcessExit('s1', 1);

    const latestSnapshotPayload = publishToSessionMock.mock.calls
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
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        requestId: 'r1',
        hasPending: false,
      })
    );
    expect(sessionDomainService.getPendingInteractiveRequest('s1')).toBeNull();
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

    publishToSessionMock.mockClear();
    const removed = sessionDomainService.removeTranscriptMessageById('s1', 'u1');

    expect(removed).toBe(true);
    expect(sessionDomainService.getTranscriptSnapshot('s1')).toEqual([]);
    expect(publishToSessionMock).toHaveBeenCalledWith(
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
    const listener = vi.fn();
    sessionDomainService.on('pending_request_changed', listener);

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
    expect(publishToSessionMock).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'session_snapshot',
        loadRequestId: 'load-2',
      })
    );

    sessionDomainService.setPendingInteractiveRequest('s1', {
      requestId: 'r1',
      toolName: 'AskUserQuestion',
      toolUseId: 'tu1',
      input: { question: 'continue?' },
      planContent: null,
      timestamp: '2026-02-14T00:00:00.000Z',
    });
    listener.mockClear();

    sessionDomainService.clearQueuedWork('s1');
    expect(sessionDomainService.getQueueLength('s1')).toBe(0);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        requestId: 'r1',
        hasPending: false,
      })
    );
    expect(sessionDomainService.getPendingInteractiveRequest('s1')).toBeNull();
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
    expect(sessionDomainService.getHistoryHydrationSource('s1')).toBe('jsonl');

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

    expect(sessionDomainService.getHistoryHydrationSource('s1')).toBe('acp_fallback');
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
