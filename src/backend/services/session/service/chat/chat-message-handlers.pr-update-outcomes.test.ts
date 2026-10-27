import { afterEach, expect, it } from 'vitest';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { ChatMessageHandlerService } from './chat-message-handlers.service';

afterEach(() => {
  sessionBackgroundDeliveryService.invalidate('w', 1);
  sessionDomainService.clearAllSessions();
});

function createPRMessage(): QueuedMessage {
  return {
    id: 'pr-event-stale-outcome',
    text: 'Review feedback',
    timestamp: '2026-10-27T00:00:00Z',
    source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
}

function rollBackStoppedDispatch(message: QueuedMessage): void {
  const handler = new ChatMessageHandlerService();
  Object.defineProperty(handler, 'isDispatchGenerationCurrent', { value: () => false });
  Reflect.apply(Reflect.get(handler, 'handleDispatchError'), handler, [
    'session',
    message,
    new Error('Provider unavailable'),
    0,
  ]);
}

it.each(['failed', 'cancelled'] as const)(
  'keeps a published PR %s outcome when a stopped dispatch rolls back its provisional message',
  (deliveryState) => {
    const message = createPRMessage();
    if (deliveryState === 'failed') {
      sessionDomainService.commitSentUserMessage('session', message);
      sessionDomainService.failMessage('session', message, 'Provider unavailable');
    } else {
      sessionDomainService.enqueue('session', message);
      sessionDomainService.removeQueuedMessage('session', message.id);
    }

    rollBackStoppedDispatch(message);

    expect(sessionDomainService.getTranscriptSnapshot('session')[0]?.message).toMatchObject({
      type: 'pr_update',
      prDeliveryState: deliveryState,
      ...(deliveryState === 'failed' ? { error: 'Provider unavailable' } : {}),
    });
  }
);

it.each([true, false])('still rolls back an unsettled message (PR update=%s)', (isPRUpdate) => {
  const message = createPRMessage();
  if (!isPRUpdate) {
    message.id = 'human-stale-dispatch';
    message.source = undefined;
  }
  sessionDomainService.commitSentUserMessage('session', message);

  rollBackStoppedDispatch(message);

  expect(sessionDomainService.getTranscriptSnapshot('session')).toEqual([]);
});

it('keeps a replacement queue message when obsolete async preparation discards', async () => {
  let discard!: (value: { status: 'discard' }) => void;
  const preparation = new Promise<{ status: 'discard' }>((resolve) => {
    discard = resolve;
  });
  sessionBackgroundDeliveryService.configure({
    prepare: () => preparation,
    validate: async () => true,
    complete: async () => undefined,
    fail: async () => ({ paused: false }),
    recover: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
  });
  const sessionId = 'async-discard';
  const request = { workspaceId: 'w', prId: 'p', bindingRevision: 1 };
  sessionBackgroundDeliveryService.enqueue(sessionId, request);
  const old = sessionDomainService.peekNextMessage(sessionId)!;
  const handler = new ChatMessageHandlerService();
  const pending = Reflect.apply(Reflect.get(handler, 'prepareBackgroundForDispatch'), handler, [
    sessionId,
    old,
    0,
  ]);
  sessionBackgroundDeliveryService.invalidate('w', 1);
  sessionBackgroundDeliveryService.enqueue(sessionId, request);
  const replacement = sessionDomainService.peekNextMessage(sessionId)!;
  expect(replacement).not.toBe(old);
  discard({ status: 'discard' });
  await pending;
  expect(sessionDomainService.peekNextMessage(sessionId)).toBe(replacement);
});

it('records a stopped prepared delivery as cancelled before the retry limit', async () => {
  const sessionId = 'stopped-prepared';
  const delivery = {
    deliveryId: 'stopped',
    sessionId,
    bindingRevision: 1,
    eventIds: ['e'],
    text: 'facts',
    attempt: 1,
  };
  sessionBackgroundDeliveryService.configure({
    prepare: async () => ({ status: 'ready', delivery }),
    validate: async () => true,
    complete: async () => undefined,
    fail: async () => ({ paused: false }),
    recover: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
  });
  sessionBackgroundDeliveryService.enqueue(sessionId, {
    workspaceId: 'w',
    prId: 'p',
    bindingRevision: 1,
  });
  const message = sessionDomainService.peekNextMessage(sessionId)!;
  await sessionBackgroundDeliveryService.prepare(sessionId, message);
  const handler = new ChatMessageHandlerService();
  await Reflect.apply(Reflect.get(handler, 'releaseStoppedBackground'), handler, [message]);
  expect(sessionDomainService.getTranscriptSnapshot(sessionId)[0]?.message?.prDeliveryState).toBe(
    'cancelled'
  );
});
