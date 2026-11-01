import { afterEach, expect, it, vi } from 'vitest';
import { EventSessionFenceError } from '@/backend/services/session/service/lifecycle/event-session-fence-error';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { SessionDispatchService } from './session-dispatch.service';
const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => logger }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it.each(['policy', 'unavailable'] as const)(
  'holds reset, resume and steering with %s authority diagnostics',
  async (kind) => {
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
    vi.spyOn(sessionDomainService, 'getQueueSnapshot').mockReturnValue([message]);
    const steer = vi.fn();
    const dequeue = vi.spyOn(sessionDomainService, 'dequeueNext');
    const send = vi.fn();
    const start = vi.fn();
    const dispatcher = new SessionDispatchService({
      eventAuthority: {
        assertOrdinary: () =>
          Promise.reject(
            kind === 'policy' ? new EventSessionFenceError() : new Error('authority unavailable')
          ),
      },
      runtimeManager: { isSessionPromptInFlight: () => true, isSessionRunning: () => true },
      configService: {
        configureQueuedMessage: async (_id, msg) => msg.settings,
        resolveQueuedMessageSettings: (_id, msg) => msg.settings,
      },
      promptService: { sendSessionMessage: send, steerSessionMessage: steer },
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
    await expect(dispatcher.steerQueuedMessage('reserved', message.id)).rejects.toThrow(
      'Session is not ready for steering'
    );
    expect(steer).not.toHaveBeenCalled();
    expect(dequeue).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    if (kind === 'policy') {
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalled();
    } else {
      expect(logger.error).toHaveBeenCalled();
    }
  }
);
