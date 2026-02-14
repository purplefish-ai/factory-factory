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

  it('markProcessExit clears queue and transcript then emits reset snapshot', () => {
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
      messages: [],
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
});
