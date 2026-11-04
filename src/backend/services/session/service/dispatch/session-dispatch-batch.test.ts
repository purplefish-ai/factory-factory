import { afterEach, expect, it, vi } from 'vitest';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { collectDispatchBatch } from './session-dispatch-batch';
import type { SessionDispatchNotificationDeliveryService } from './session-dispatch.types';

afterEach(() => sessionDomainService.clearAllSessions());

it('stops a ready batch before a message with pending human admission', async () => {
  const first: QueuedMessage = {
    id: 'first',
    text: 'ready',
    timestamp: '2026-11-04T00:00:00Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
  const second = { ...first, id: 'second' };
  const release = sessionDomainService.holdMessageForAdmission(second);
  sessionDomainService.enqueue('session', first);
  sessionDomainService.enqueue('session', second);
  try {
    const batch = await collectDispatchBatch({
      sessionId: 'session',
      first,
      notifications: unsafeCoerce<SessionDispatchNotificationDeliveryService>({
        isMailSignalQuarantined: () => false,
      }),
      prepareBackground: vi.fn().mockResolvedValue(true),
      isCurrent: () => true,
    });
    expect(batch.messages).toEqual([first]);
    expect(sessionDomainService.takeQueuedPrefix('session', [first, second])).toBe(false);
    expect(sessionDomainService.takeQueuedMessages('session', [second])).toBe(false);
    expect(sessionDomainService.getQueueSnapshot('session')).toEqual([first, second]);
    release();
    expect(sessionDomainService.takeQueuedPrefix('session', [first, second])).toBe(true);
    batch.release();
  } finally {
    release();
  }
});

it.each(['hello', '/compact'])(
  'retries collection when the selected %s object is no longer the head',
  async (text) => {
    const first: QueuedMessage = {
      id: 'first',
      text,
      timestamp: '2026-11-02T00:00:00Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    };
    const replacement = { ...first };
    sessionDomainService.enqueue('session', replacement);
    const claimForDispatch = vi.fn(() => ({ status: 'not_notification' as const }));
    const notifications: SessionDispatchNotificationDeliveryService = {
      configureRetry: () => undefined,
      recoverSession: async () => undefined,
      captureMailSignalReceipt: () => null,
      isMailSignalQuarantined: () => false,
      isOwnedMailSignal: () => false,
      claimForDispatch,
      isAlreadyDelivered: async () => false,
      acknowledgeSuccessfulDispatch: async () => undefined,
      recoverPending: async () => ({ dispatchableCount: 0 }),
      resetSession: () => undefined,
      removeDuplicateFromQueue: () => false,
      isNotificationMessage: () => false,
    };
    const prepareBackground = vi.fn(async () => true);

    const batch = await collectDispatchBatch({
      sessionId: 'session',
      first,
      notifications,
      prepareBackground,
      isCurrent: () => true,
    });

    expect(batch).toMatchObject({ status: 'retry' });
    expect(prepareBackground).not.toHaveBeenCalled();
    expect(claimForDispatch).not.toHaveBeenCalled();
    expect(sessionDomainService.peekNextMessage('session')).toBe(replacement);
    expect(sessionDomainService.getQueueLength('session')).toBe(1);
    batch.release();
  }
);
