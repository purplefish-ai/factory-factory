import { afterEach, expect, it, vi } from 'vitest';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { SessionDispatchService } from './session-dispatch.service';
afterEach(() => vi.restoreAllMocks());
it('cannot bypass an event fence with reset, manual resume, retry or steering', async () => {
  const message = {
    id: 'human',
    text: 'follow up',
    timestamp: new Date().toISOString(),
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
  vi.spyOn(sessionDomainService, 'peekNextMessage').mockReturnValue(message);
  const dequeue = vi.spyOn(sessionDomainService, 'dequeueNext');
  const send = vi.fn();
  const start = vi.fn();
  const dispatcher = new SessionDispatchService({
    eventAuthority: { assertOrdinary: () => Promise.reject(new Error('event fenced')) },
    runtimeManager: { isSessionPromptInFlight: () => false, isSessionRunning: () => true },
    configService: {
      configureQueuedMessage: async (_id, msg) => msg.settings,
      resolveQueuedMessageSettings: (_id, msg) => msg.settings,
    },
    promptService: { sendSessionMessage: send, steerSessionMessage: vi.fn() },
    backgroundDelivery: sessionBackgroundDeliveryService,
  });
  dispatcher.configure({
    initPolicy: { getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'allowed' }) },
  });
  dispatcher.configureLifecycle({
    gate: {
      getGeneration: () => 1,
      isGenerationCurrent: () => true,
      isSessionStopping: () => false,
    },
    startup: { getSessionClient: () => undefined, getOrCreateSessionClient: start },
    notificationDelivery: {
      recoverPending: async () => ({ dispatchableCount: 0 }),
      claimForDispatch: () => ({ status: 'not_notification' }),
      isAlreadyDelivered: async () => false,
      acknowledgeSuccessfulDispatch: async () => undefined,
      removeDuplicateFromQueue: () => false,
      resetSession: () => undefined,
      isNotificationMessage: () => false,
    },
  });
  dispatcher.resetDispatchState('reserved');
  dispatcher.setManualDispatchResume('reserved', true);
  await dispatcher.tryDispatchNextMessage('reserved', { bypassTurnInProgressBackoff: true });
  await dispatcher.steerQueuedMessage('reserved', message.id).catch(() => undefined);
  expect(dequeue).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
