import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEventBus } from '@/backend/services/session/service/event-bus/session-event-bus';
import type { QueuedMessage, SessionDeltaEvent, WebSocketMessage } from '@/shared/acp-protocol';
import { sessionDomainService } from './session-domain.service';

function queued(id: string, overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id,
    text: id,
    timestamp: '2026-11-03T00:00:00.000Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
    ...overrides,
  };
}

const pendingRequest = {
  requestId: 'r1',
  toolName: 'Bash',
  toolUseId: 'tool-1',
  input: { command: 'ls' },
  planContent: null,
  timestamp: '2026-11-03T00:00:00.000Z',
};

let published: WebSocketMessage[];

beforeEach(() => {
  sessionDomainService.clearAllSessions();
  published = [];
  vi.spyOn(sessionEventBus, 'publishToSession').mockImplementation((_sessionId, payload) => {
    published.push(payload);
  });
});

function snapshots() {
  return published.filter((payload) => payload.type === 'session_snapshot');
}

function deltas(): SessionDeltaEvent[] {
  return published.flatMap((payload) => (payload.type === 'session_delta' ? [payload.data] : []));
}

/** Seed a large transcript so a snapshot would carry far more than the delta. */
function seedTranscript(count: number) {
  for (let index = 0; index < count; index += 1) {
    sessionDomainService.commitSentUserMessage('s1', queued(`history-${index}`));
  }
  published = [];
}

describe('targeted session-state deltas', () => {
  it('publishes the queue, not a transcript snapshot, for queue-only changes', () => {
    seedTranscript(50);

    sessionDomainService.enqueue('s1', queued('q1'));
    sessionDomainService.enqueue('s1', queued('q2'));
    sessionDomainService.dequeueNext('s1');
    sessionDomainService.requeueFront('s1', queued('q0'));
    sessionDomainService.removeQueuedMessage('s1', 'q2');

    expect(snapshots()).toEqual([]);
    expect(deltas().map((delta) => delta.type)).toEqual([
      'queue_updated',
      'queue_updated',
      'queue_updated',
      'queue_updated',
      'queue_updated',
    ]);
    expect(
      deltas().map((delta) =>
        delta.type === 'queue_updated' ? delta.queuedMessages.map(({ id }) => id) : null
      )
    ).toEqual([['q1'], ['q1', 'q2'], ['q2'], ['q0', 'q2'], ['q0']]);
  });

  it('does not publish a dequeue when the caller publishes the handoff itself', () => {
    sessionDomainService.enqueue('s1', queued('q1'));
    published = [];
    sessionDomainService.dequeueNext('s1', { publish: false });
    expect(published).toEqual([]);
  });

  it('publishes a committed entry with the remaining queue instead of a snapshot', () => {
    seedTranscript(50);
    sessionDomainService.enqueue('s1', queued('q1'));
    sessionDomainService.enqueue('s1', queued('q2'));
    const [first] = sessionDomainService.getQueueSnapshot('s1');
    expect(first).toBeDefined();
    sessionDomainService.takeQueuedPrefix('s1', first ? [first] : []);
    published = [];

    sessionDomainService.commitSentUserMessageAtOrder('s1', queued('q1'), 77);

    expect(snapshots()).toEqual([]);
    expect(deltas()).toEqual([
      {
        type: 'transcript_message_committed',
        chatMessage: {
          id: 'q1',
          source: 'user',
          text: 'q1',
          timestamp: '2026-11-03T00:00:00.000Z',
          order: 77,
          attachments: undefined,
        },
        queuedMessages: [queued('q2')],
      },
    ]);
  });

  it('commits a background PR message as its transcript entry', () => {
    const request = { workspaceId: 'w', prId: 'p', bindingRevision: 1 };
    sessionDomainService.commitSentUserMessage(
      's1',
      queued('pr-event-1', { text: 'PR update', source: { type: 'pr_event', request } })
    );
    expect(deltas()).toEqual([
      expect.objectContaining({
        type: 'transcript_message_committed',
        chatMessage: expect.objectContaining({
          id: 'pr-event-1',
          source: 'agent',
          message: { type: 'pr_update', text: 'PR update' },
        }),
      }),
    ]);
  });

  it('can defer commit publication to the caller', () => {
    sessionDomainService.commitSentUserMessage('s1', queued('q1'), { publish: false });
    expect(published).toEqual([]);
  });

  it('publishes pending-request changes without a snapshot', () => {
    seedTranscript(50);

    sessionDomainService.setPendingInteractiveRequest('s1', pendingRequest);
    expect(sessionDomainService.clearPendingInteractiveRequestIfMatches('s1', 'stale')).toBe(false);
    expect(sessionDomainService.clearPendingInteractiveRequestIfMatches('s1', 'r1')).toBe(true);
    sessionDomainService.setPendingInteractiveRequest('s1', { ...pendingRequest, requestId: 'r2' });
    sessionDomainService.clearPendingInteractiveRequest('s1');
    sessionDomainService.clearPendingInteractiveRequest('s1');

    expect(snapshots()).toEqual([]);
    expect(deltas()).toEqual([
      { type: 'pending_request_updated', pendingInteractiveRequest: pendingRequest },
      { type: 'pending_request_updated', pendingInteractiveRequest: null },
      {
        type: 'pending_request_updated',
        pendingInteractiveRequest: { ...pendingRequest, requestId: 'r2' },
      },
      { type: 'pending_request_updated', pendingInteractiveRequest: null },
    ]);
  });

  it('keeps snapshots where a PR queue change also rewrites the transcript', () => {
    const request = { workspaceId: 'w', prId: 'p', bindingRevision: 1 };
    sessionDomainService.enqueue(
      's1',
      queued('pr-event-1', { source: { type: 'pr_event', request } })
    );
    expect(snapshots()).toHaveLength(1);

    published = [];
    sessionDomainService.removeQueuedMessage('s1', 'pr-event-1');
    expect(snapshots()).toHaveLength(1);
    expect(sessionDomainService.getTranscriptSnapshot('s1')).toEqual([
      expect.objectContaining({
        id: 'pr-event-1',
        message: expect.objectContaining({ prDeliveryState: 'cancelled' }),
      }),
    ]);
  });

  it('keeps full snapshots for cleared queued work and injected replay messages', () => {
    sessionDomainService.enqueue('s1', queued('q1'));
    published = [];

    sessionDomainService.clearQueuedWork('s1');
    expect(snapshots()).toHaveLength(1);

    published = [];
    sessionDomainService.injectCommittedUserMessage('s1', 'Cached history');
    expect(snapshots()).toHaveLength(1);
  });

  it('publishes a queue change made without its own publication on request', () => {
    sessionDomainService.enqueue('s1', queued('q1'));
    const [first] = sessionDomainService.getQueueSnapshot('s1');
    sessionDomainService.takeQueuedPrefix('s1', first ? [first] : []);
    published = [];

    sessionDomainService.publishQueue('s1');
    sessionDomainService.publishQueue('missing');

    expect(published).toEqual([
      { type: 'session_delta', data: { type: 'queue_updated', queuedMessages: [] } },
    ]);
  });

  it('keeps each delta far smaller than the snapshot it replaces', () => {
    const output = 'x'.repeat(2000);
    for (let index = 0; index < 200; index += 1) {
      sessionDomainService.commitSentUserMessage(
        's1',
        queued(`history-${index}`, { text: output })
      );
    }
    published = [];

    sessionDomainService.enqueue('s1', queued('q1'));
    sessionDomainService.setPendingInteractiveRequest('s1', pendingRequest);
    sessionDomainService.emitSessionSnapshot('s1');

    const sizes = published.map((payload) => JSON.stringify(payload).length);
    const snapshotSize = sizes.at(-1) ?? 0;
    expect(snapshotSize).toBeGreaterThan(400_000);
    for (const size of sizes.slice(0, -1)) {
      expect(size).toBeLessThan(1000);
    }
  });
});
