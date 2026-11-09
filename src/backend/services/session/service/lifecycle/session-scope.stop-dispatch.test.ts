import { afterEach, expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { SessionDispatchService } from '@/backend/services/session/service/dispatch/session-dispatch.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createTerminationHarness } from './session-lifecycle.test-helpers';

const SESSION_ID = 'session-1';

function enqueue(id: string): QueuedMessage {
  const message: QueuedMessage = {
    id,
    text: id,
    timestamp: '2026-11-09T00:00:00Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
  sessionDomainService.enqueue(SESSION_ID, message);
  return message;
}

/**
 * Wires a real dispatcher and a real termination coordinator through the
 * session scope exactly as session-services.ts does, so the stop below goes
 * through the coordinator directly rather than the WebSocket stop handler.
 */
function stopHarness() {
  const termination = createTerminationHarness();
  const sendSessionMessage = vi
    .fn<(sessionId: string, content: string | AgentContentItem[]) => Promise<void>>()
    .mockResolvedValue(undefined);
  const dispatcher = new SessionDispatchService({
    runtimeManager: {
      isSessionPromptInFlight: () => false,
      isSessionRunning: () => true,
    },
    configService: {
      resolveQueuedMessageSettings: (_id, message) => message.settings,
      configureQueuedMessage: (_id, message) => Promise.resolve(message.settings),
    },
    promptService: {
      sendSessionMessage,
      steerSessionMessage: vi.fn().mockResolvedValue({ outcome: 'injected' }),
    },
    backgroundDelivery: {
      prepare: vi.fn(),
      validate: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
    },
  });
  dispatcher.configure({
    initPolicy: { getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'allowed' }) },
  });
  const client = unsafeCoerce<AcpProcessHandle>({});
  dispatcher.configureLifecycle({
    gate: termination.lifecycleGate,
    startup: {
      getSessionClient: () => client,
      getOrCreateSessionClient: () => Promise.resolve(client),
    },
    notificationDelivery: {
      configureRetry: () => undefined,
      recoverSession: async () => undefined,
      captureMailSignalReceipt: () => null,
      isMailSignalQuarantined: () => false,
      isOwnedMailSignal: () => false,
      claimForDispatch: () => ({ status: 'not_notification' }),
      isAlreadyDelivered: async () => false,
      acknowledgeSuccessfulDispatch: async () => undefined,
      recoverPending: async () => ({ dispatchableCount: 0 }),
      resetSession: () => undefined,
      removeDuplicateFromQueue: () => false,
      isNotificationMessage: () => false,
    },
  });
  termination.scope.register('dispatch', {
    completeStop: (id) => dispatcher.resetDispatchState(id),
    forget: (id) => dispatcher.forgetSession(id),
  });
  vi.spyOn(sessionDataService, 'findAgentSessionById').mockResolvedValue(
    unsafeCoerce({ workspace: { status: 'READY', worktreePath: '/tmp/workspace' } })
  );
  return { termination, dispatcher, sendSessionMessage };
}

afterEach(() => {
  sessionDomainService.clearAllSessions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('releases a dispatch claim stranded by a never-settling turn on a non-WebSocket stop', async () => {
  const { termination, dispatcher, sendSessionMessage } = stopHarness();
  sendSessionMessage.mockReturnValueOnce(new Promise<void>(() => undefined));
  enqueue('first');
  void dispatcher.tryDispatchNextMessage(SESSION_ID);
  await vi.waitFor(() => expect(sendSessionMessage).toHaveBeenCalledOnce());

  await termination.coordinator.stopSession(SESSION_ID, { reason: 'SYSTEM_STOP' });

  enqueue('second');
  await dispatcher.tryDispatchNextMessage(SESSION_ID);
  expect(sendSessionMessage).toHaveBeenLastCalledWith(SESSION_ID, 'second');
  expect(sessionDomainService.getQueueLength(SESSION_ID)).toBe(0);
});

it('cancels a busy-provider retry timer on a non-WebSocket stop', async () => {
  vi.useFakeTimers();
  const { termination, dispatcher, sendSessionMessage } = stopHarness();
  sendSessionMessage.mockRejectedValueOnce(
    new Error('A turn is already in progress for this session')
  );
  enqueue('busy');
  await dispatcher.tryDispatchNextMessage(SESSION_ID);
  expect(vi.getTimerCount()).toBe(1);

  await termination.coordinator.stopSession(SESSION_ID, { reason: 'SYSTEM_STOP' });
  expect(vi.getTimerCount()).toBe(0);

  sessionDomainService.clearQueuedWork(SESSION_ID);
  enqueue('after-stop');
  await dispatcher.tryDispatchNextMessage(SESSION_ID);
  expect(sendSessionMessage).toHaveBeenLastCalledWith(SESSION_ID, 'after-stop');
  await vi.runAllTimersAsync();
  expect(sendSessionMessage).toHaveBeenCalledTimes(2);
});

it('forgets manual dispatch resumption when the session is deleted', async () => {
  const { termination, dispatcher, sendSessionMessage } = stopHarness();
  dispatcher.configure({
    initPolicy: { getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'manual_resume' }) },
  });
  dispatcher.setManualDispatchResume(SESSION_ID, true);

  termination.scope.forget(SESSION_ID);

  enqueue('held');
  await dispatcher.tryDispatchNextMessage(SESSION_ID);
  expect(sendSessionMessage).not.toHaveBeenCalled();
  expect(sessionDomainService.peekNextMessage(SESSION_ID)?.id).toBe('held');
});
