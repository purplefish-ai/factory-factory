import { afterEach, expect, it, vi } from 'vitest';
import { createQueueMessageHandler } from '@/backend/services/session/service/chat/chat-message-handlers/handlers/queue-message.handler';
import { sessionEventBus } from '@/backend/services/session/service/event-bus/session-event-bus';
import { sessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { collectDispatchBatch } from './session-dispatch-batch';
import { enqueue, harness, pendingCall } from './session-dispatch-harness.test-helpers';
import { visibleIdsAfterEachEvent } from './session-dispatch-visibility.test-helpers';
import type { SessionDispatchNotificationDeliveryService } from './session-dispatch.types';

afterEach(() => {
  sessionDomainService.clearAllSessions();
  vi.restoreAllMocks();
});

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

it('sends the original prompt once across queued, claimed, and committed retries', async () => {
  const h = harness();
  const context = { sessionId: 'session', workingDir: '/tmp' };
  const message = { type: 'queue_message', id: 'original', text: 'only once' } as const;
  const run = createQueueMessageHandler({
    domain: sessionDomainService,
    backgroundDelivery: {
      captureResumeGuard: () => () => true,
      userResume: async () => undefined,
    },
    tryDispatchNextMessage: async () => undefined,
  });
  await run(context, message);
  await run(context, message);
  const gate = pendingCall<QueuedMessage['settings']>();
  h.configureQueuedMessage.mockImplementationOnce(gate.invoke);
  const dispatch = h.dispatcher.tryDispatchNextMessage('session');
  await gate.started;
  try {
    expect((await run(context, message)).replies).toMatchObject([
      { newState: 'ACCEPTED', id: 'original' },
    ]);
  } finally {
    gate.resolve({
      selectedModel: 'effective',
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    });
    await dispatch;
  }
  await run(context, message);
  expect((await run(context, { ...message, voiceMode: true })).replies).toMatchObject([
    { type: 'error', error: { kind: 'queue_input_invalid' } },
  ]);
  await h.dispatcher.tryDispatchNextMessage('session');
  expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'only once');
  expect(sessionDomainService.getTranscriptSnapshot('session').map(({ text }) => text)).toEqual([
    'only once',
  ]);
});

it('shows the claimed batch in replay and queue updates while provider configuration is pending', async () => {
  const h = harness();
  const first = enqueue('first');
  const second = enqueue('second');
  const gate = pendingCall<QueuedMessage['settings']>();
  h.configureQueuedMessage.mockImplementationOnce(gate.invoke);
  const run = h.dispatcher.tryDispatchNextMessage('session');
  await gate.started;
  try {
    const publish = vi.spyOn(sessionEventBus, 'publishToSession');
    enqueue('late');
    const replay = sessionDomainService.prepareLoad(
      'session',
      sessionDomainService.getRuntimeSnapshot('session')
    );
    const ids = replay.replayEvents.flatMap((event) =>
      event.type === 'message_state_changed' && event.newState === 'ACCEPTED' ? [event.id] : []
    );
    expect(ids).toEqual(['first', 'second', 'late']);
    expect(
      visibleIdsAfterEachEvent(
        publish.mock.calls.map(([, frame]) => frame),
        ['first', 'second']
      ).at(-1)?.visible
    ).toEqual(['first', 'second', 'late']);
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
  } finally {
    gate.resolve(second.settings);
    await run;
  }
  expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'first\n\nsecond');
  expect(sessionDomainService.getTranscriptSnapshot('session').map(({ id }) => id)).toEqual([
    first.id,
    second.id,
  ]);
});
