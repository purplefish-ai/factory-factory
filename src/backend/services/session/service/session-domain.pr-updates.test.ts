import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { SessionDomainService } from './session-domain.service';
import { sessionEventBus } from './session-event-bus';

const message: QueuedMessage = {
  id: 'pr-event-test',
  text: '<!-- factory-factory-pr-event:test -->\nCI failed',
  timestamp: '2026-10-27T00:00:00Z',
  source: {
    type: 'pr_event',
    request: { workspaceId: 'workspace', prId: 'pr', bindingRevision: 1 },
  },
  settings: {
    selectedModel: null,
    reasoningEffort: null,
    thinkingEnabled: false,
    planModeEnabled: false,
  },
};
afterEach(() => {
  vi.restoreAllMocks();
});

describe('PR update transcript outcomes', () => {
  it('retains cancellation in snapshots and replay when removing queued PR work', () => {
    const service = new SessionDomainService();
    const publish = vi.spyOn(sessionEventBus, 'publishToSession');
    service.enqueue('session', message);
    expect(service.removeQueuedMessage('session', message.id)).toBe(true);
    expect(service.getQueueLength('session')).toBe(0);
    expect(service.getTranscriptSnapshot('session')).toEqual([
      expect.objectContaining({
        id: message.id,
        source: 'agent',
        message: expect.objectContaining({
          type: 'pr_update',
          text: message.text,
          prDeliveryState: 'cancelled',
        }),
      }),
    ]);
    service.subscribe({
      sessionId: 'session',
      sessionRuntime: service.getRuntimeSnapshot('session'),
    });
    expect(publish).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        type: 'session_replay_batch',
        replayEvents: expect.arrayContaining([
          expect.objectContaining({
            type: 'agent_message',
            data: expect.objectContaining({ prDeliveryState: 'cancelled' }),
          }),
        ]),
      })
    );
  });
  it('retains a failed dispatch without emitting rejected-message recovery', () => {
    const service = new SessionDomainService();
    const publish = vi.spyOn(sessionEventBus, 'publishToSession');
    service.commitSentUserMessage('session', message);
    service.removeTranscriptMessageById('session', message.id, { emitSnapshot: false });
    service.failMessage('session', message, 'Provider unavailable');
    expect(service.getTranscriptSnapshot('session')).toEqual([
      expect.objectContaining({
        id: message.id,
        source: 'agent',
        message: expect.objectContaining({
          prDeliveryState: 'failed',
          error: 'Provider unavailable',
        }),
      }),
    ]);
    expect(publish).not.toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        type: 'session_delta',
        data: expect.objectContaining({ type: 'message_state_changed' }),
      })
    );
    service.subscribe({
      sessionId: 'session',
      sessionRuntime: service.getRuntimeSnapshot('session'),
    });
    expect(publish).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        type: 'session_replay_batch',
        replayEvents: expect.arrayContaining([
          expect.objectContaining({
            type: 'agent_message',
            data: expect.objectContaining({
              type: 'pr_update',
              prDeliveryState: 'failed',
              error: 'Provider unavailable',
            }),
          }),
        ]),
      })
    );
  });
  it('clears queued PR work into a cancelled card and replaces it on an explicit retry', () => {
    const service = new SessionDomainService();
    service.enqueue('session', message);
    service.clearQueuedWork('session');
    expect(service.getQueueLength('session')).toBe(0);
    expect(service.getTranscriptSnapshot('session')[0]).toMatchObject({
      message: { prDeliveryState: 'cancelled' },
    });
    service.enqueue('session', message);
    expect(service.getQueueLength('session')).toBe(1);
    expect(service.getTranscriptSnapshot('session')).toEqual([]);
  });
  it('ignores a stale dispatch failure after a new queue token reuses its ID', () => {
    const service = new SessionDomainService();
    service.enqueue('session', message);
    service.removeQueuedMessage('session', message.id);
    const replacement = { ...message, text: 'Newer PR facts' };
    service.enqueue('session', replacement);
    service.failMessage('session', message, 'Old dispatch failed');
    expect(service.peekNextMessage('session')).toBe(replacement);
    expect(service.getTranscriptSnapshot('session')).toEqual([]);
  });
  it('preserves a cancelled PR outcome through inactive session cleanup and rejection expiry', () => {
    vi.useFakeTimers();
    const service = new SessionDomainService();
    try {
      service.enqueue('session', message);
      service.removeQueuedMessage('session', message.id);
      service.rejectMessage('session', 'human-message', 'Rejected');
      service.clearSession('session', { preserveRejections: true });
      expect(service.getTranscriptSnapshot('session')[0]?.message).toMatchObject({
        prDeliveryState: 'cancelled',
      });
      vi.advanceTimersByTime(60_001);
      expect(service.getTranscriptSnapshot('session')[0]?.message).toMatchObject({
        prDeliveryState: 'cancelled',
      });
      service.clearSession('session', { permanentlyDeleted: true });
      expect(service.getTranscriptSnapshot('session')).toEqual([]);
    } finally {
      service.clearAllSessions();
      vi.useRealTimers();
    }
  });

  it('does not cancel a replacement queued PR update during stale async cleanup', () => {
    const service = new SessionDomainService();
    service.enqueue('session', message);
    service.removeQueuedMessage('session', message.id);
    const replacement = { ...message, text: 'Newer facts' };
    service.enqueue('session', replacement);
    expect(service.removeQueuedMessage('session', message.id, { expectedMessage: message })).toBe(
      false
    );
    expect(service.peekNextMessage('session')).toBe(replacement);
    expect(service.getTranscriptSnapshot('session')).toEqual([]);
  });
  it('replaces an unprepared queued placeholder with cancellation copy', () => {
    const service = new SessionDomainService();
    service.enqueue('session', { ...message, text: 'PR update queued for the next turn' });
    service.removeQueuedMessage('session', message.id);
    expect(service.getTranscriptSnapshot('session')[0]?.message).toMatchObject({
      prDeliveryState: 'cancelled',
      text: 'PR update cancelled before dispatch',
    });
  });
  it('records explicit session-stop cancellation separately from delivery failure', () => {
    const service = new SessionDomainService();
    service.failMessage('session', message, 'Session stopped before dispatch', 'cancelled');
    expect(service.getTranscriptSnapshot('session')[0]?.message).toMatchObject({
      prDeliveryState: 'cancelled',
      error: 'Session stopped before dispatch',
    });
  });
});
