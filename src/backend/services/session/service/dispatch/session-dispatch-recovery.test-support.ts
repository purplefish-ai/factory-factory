import { vi, type Mock } from 'vitest';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import type { SessionNotificationDeliveryService } from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionDispatchService } from './session-dispatch.service';

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function enqueue(id: string) {
  const message: QueuedMessage = {
    id,
    text: id,
    timestamp: '2026-10-27T00:00:00Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
  sessionDomainService.enqueue('session', message);
  return message;
}

type DispatchHarness = {
  dispatcher: SessionDispatchService;
  sendSessionMessage: Mock<
    (sessionId: string, content: string | AgentContentItem[]) => Promise<void>
  >;
  steerSessionMessage: Mock;
  startup: { getSessionClient: Mock<() => unknown>; getOrCreateSessionClient: Mock };
  runtimeManager: {
    isSessionWorking: Mock<() => boolean>;
    isSessionPromptInFlight: Mock<() => boolean>;
    isSessionRunning: Mock<() => boolean>;
  };
  resolveQueuedMessageSettings: Mock<
    (id: string, message: QueuedMessage) => QueuedMessage['settings']
  >;
  configureQueuedMessage: Mock<
    (id: string, message: QueuedMessage) => Promise<QueuedMessage['settings']>
  >;
  backgroundDelivery: { prepare: Mock; validate: Mock; fail: Mock; complete: Mock };
  stop(): void;
};

export function harness(
  policy: 'allowed' | 'manual_resume' = 'allowed',
  notifications?: SessionNotificationDeliveryService,
  eventAuthority?: { assertOrdinary(id: string): Promise<void> }
): DispatchHarness {
  let generation = 0;
  const sendSessionMessage = vi
    .fn<(sessionId: string, content: string | AgentContentItem[]) => Promise<void>>()
    .mockResolvedValue(undefined);
  const steerSessionMessage = vi.fn().mockResolvedValue({ outcome: 'injected' });
  const startup = {
    getSessionClient: vi.fn<() => unknown>().mockReturnValue({}),
    getOrCreateSessionClient: vi.fn().mockResolvedValue({}),
  };
  const runtimeManager = {
    isSessionWorking: vi.fn(() => false),
    isSessionPromptInFlight: vi.fn(() => false),
    isSessionRunning: vi.fn(() => true),
  };
  const resolveQueuedMessageSettings = vi.fn(
    (_id: string, message: QueuedMessage) => message.settings
  );
  const configureQueuedMessage = vi.fn((_id: string, message: QueuedMessage) =>
    Promise.resolve(message.settings)
  );
  const backgroundDelivery = {
    prepare: vi.fn(),
    validate: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  const dispatcher = new SessionDispatchService({
    eventAuthority,
    runtimeManager,
    configService: {
      resolveQueuedMessageSettings,
      configureQueuedMessage,
    },
    promptService: { sendSessionMessage, steerSessionMessage },
    backgroundDelivery,
  });
  dispatcher.configure({
    initPolicy: { getWorkspaceInitPolicy: () => ({ dispatchPolicy: policy }) },
  });
  dispatcher.configureLifecycle({
    gate: {
      getGeneration: () => generation,
      isGenerationCurrent: (_sessionId, expected) => expected === generation,
      isSessionStopping: () => false,
    },
    startup,
    notificationDelivery: notifications ?? {
      claimForDispatch: () => ({ status: 'not_notification' }),
      getDispatchState: async () => 'pending',
      acknowledgeSuccessfulDispatch: async () => undefined,
      recoverPending: async () => ({ dispatchableCount: 0 }),
      resetSession: () => undefined,
      removeBlockedFromQueue: () => false,
      isNotificationMessage: () => false,
    },
  });
  vi.spyOn(sessionDataService, 'findAgentSessionById').mockResolvedValue(
    unsafeCoerce({ workspace: { status: 'READY', worktreePath: '/tmp/workspace' } })
  );
  return {
    dispatcher,
    steerSessionMessage,
    resolveQueuedMessageSettings,
    sendSessionMessage,
    startup,
    runtimeManager,
    configureQueuedMessage,
    backgroundDelivery,
    stop: () => {
      generation += 1;
    },
  };
}
