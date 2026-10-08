import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from '@/shared/acp-protocol';

const {
  mockSessionDomainService,
  mockSessionService,
  mockSessionDataService,
  mockNotificationDeliveryService,
} = vi.hoisted(() => ({
  mockSessionDomainService: {
    peekNextMessage: vi.fn(),
    dequeueNext: vi.fn(),
    requeueFront: vi.fn(),
    markError: vi.fn(),
    markIdle: vi.fn(),
    markRunning: vi.fn(),
    allocateOrder: vi.fn(),
    emitDelta: vi.fn(),
    emitSessionSnapshot: vi.fn(),
    failMessage: vi.fn(),
    commitSentUserMessageAtOrder: vi.fn(),
    removeTranscriptMessageById: vi.fn(),
    removeQueuedMessage: vi.fn(),
    getQueueLength: vi.fn(),
    getTranscriptSnapshot: vi.fn(),
    getPendingInteractiveRequest: vi.fn(),
  },
  mockSessionService: {
    getClient: vi.fn(),
    getSessionClient: vi.fn(),
    getOrCreateSessionClient: vi.fn(),
    isSessionStopping: vi.fn(),
    getGeneration: vi.fn(),
    isGenerationCurrent: vi.fn(),
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    setSessionModel: vi.fn(),
    setSessionReasoningEffort: vi.fn(),
    setSessionThinkingBudget: vi.fn(),
    setSessionCollaborationMode: vi.fn(),
    sendSessionMessage: vi.fn(),
  },
  mockSessionDataService: {
    findAgentSessionById: vi.fn(),
  },
  mockNotificationDeliveryService: {
    recoverPending: vi.fn(),
    claimForDispatch: vi.fn(),
    isAlreadyDelivered: vi.fn(),
    acknowledgeSuccessfulDispatch: vi.fn(),
    removeDuplicateFromQueue: vi.fn(),
    resetSession: vi.fn(),
    isNotificationMessage: vi.fn(),
  },
}));

vi.mock('@/backend/services/session/service/session-domain.service', () => ({
  sessionDomainService: mockSessionDomainService,
}));

vi.mock('@/backend/services/session/service/acp', () => ({
  acpRuntimeManager: mockSessionService,
}));

vi.mock('@/backend/services/session/service/lifecycle/session-core-services', () => ({
  sessionConfigService: mockSessionService,
  sessionLifecycleService: mockSessionService,
  sessionPermissionService: {},
  sessionService: mockSessionService,
}));

vi.mock('@/backend/services/session/service/data/session-data.service', () => ({
  sessionDataService: mockSessionDataService,
}));

vi.mock('./chat-message-handlers/registry', () => ({
  createChatMessageHandlerRegistry: () => ({}),
}));

import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { ChatMessageHandlerService } from './chat-message-handlers.service';

const chatMessageHandlerService = new ChatMessageHandlerService();

describe('chatMessageHandlerService.tryDispatchNextMessage', () => {
  const queuedMessage: QueuedMessage = {
    id: 'm1',
    text: 'hello',
    timestamp: '2026-02-01T00:00:00.000Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
  beforeEach(() => {
    vi.clearAllMocks();
    chatMessageHandlerService.resetDispatchState('s1');
    chatMessageHandlerService.configure({
      initPolicy: {
        getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'allowed' }),
      },
    });
    chatMessageHandlerService.configureLifecycle({
      gate: mockSessionService,
      startup: mockSessionService,
      notificationDelivery: mockNotificationDeliveryService,
    });
    mockSessionDomainService.peekNextMessage.mockReturnValue(queuedMessage);
    mockSessionDomainService.dequeueNext.mockReturnValue(queuedMessage);
    mockSessionDomainService.allocateOrder.mockReturnValue(0);
    mockSessionService.setSessionThinkingBudget.mockResolvedValue(undefined);
    mockSessionService.setSessionModel.mockResolvedValue(undefined);
    mockSessionService.setSessionReasoningEffort.mockResolvedValue(undefined);
    mockSessionService.setSessionCollaborationMode.mockResolvedValue(undefined);
    mockSessionService.sendSessionMessage.mockResolvedValue(undefined);
    mockNotificationDeliveryService.claimForDispatch.mockReturnValue({
      status: 'not_notification',
    });
    mockNotificationDeliveryService.isAlreadyDelivered.mockResolvedValue(false);
    mockNotificationDeliveryService.acknowledgeSuccessfulDispatch.mockResolvedValue(undefined);
    mockNotificationDeliveryService.removeDuplicateFromQueue.mockReturnValue(true);
    mockNotificationDeliveryService.isNotificationMessage.mockReturnValue(false);
    mockNotificationDeliveryService.recoverPending.mockResolvedValue({ dispatchableCount: 0 });
    mockSessionDomainService.getTranscriptSnapshot.mockReturnValue([]);
    mockSessionDomainService.removeQueuedMessage.mockReturnValue(true);
    mockSessionService.getOrCreateSessionClient.mockResolvedValue(undefined);
    mockSessionService.isSessionWorking.mockReturnValue(false);
    mockSessionService.isSessionRunning.mockReturnValue(true);
    mockSessionService.isSessionStopping.mockReturnValue(false);
    mockSessionService.getGeneration.mockReturnValue(0);
    mockSessionService.isGenerationCurrent.mockReturnValue(true);
    mockSessionDataService.findAgentSessionById.mockResolvedValue({
      workspace: {
        status: 'READY',
        worktreePath: '/tmp/w1',
        initErrorMessage: null,
      },
    });
  });

  it.each(['runtime-stopped', 'generation-stopped'] as const)(
    'releases the prepared PR claim when the recipient becomes %s during client resolution',
    async (stop) => {
      const background: QueuedMessage = {
        ...queuedMessage,
        id: `pr-event-${stop}`,
        source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
      };
      const delivery = {
        deliveryId: `delivery-${stop}`,
        sessionId: 's1',
        bindingRevision: 1,
        eventIds: ['e'],
        text: 'facts',
        attempt: 1,
      };
      const fail = vi.fn().mockResolvedValue(undefined);
      sessionBackgroundDeliveryService.configure({
        prepare: () => Promise.resolve({ status: 'ready', delivery }),
        validate: () => Promise.resolve(true),
        complete: () => Promise.resolve(),
        fail,
        recover: () => Promise.resolve(),
        pause: () => Promise.resolve(),
        resume: () => Promise.resolve(),
      });
      mockSessionDomainService.peekNextMessage.mockReturnValue(background);
      mockSessionDomainService.getPendingInteractiveRequest.mockReturnValue(null);
      mockSessionService.getSessionClient.mockReturnValue({ providerSessionId: 'existing' });
      mockSessionService.getOrCreateSessionClient.mockImplementation(() => {
        if (stop === 'runtime-stopped') {
          mockSessionService.isSessionRunning.mockReturnValue(false);
        } else {
          mockSessionService.isGenerationCurrent.mockReturnValue(false);
        }
        return Promise.resolve();
      });
      try {
        await chatMessageHandlerService.tryDispatchNextMessage('s1');
        expect(fail).toHaveBeenCalledWith(
          delivery,
          expect.objectContaining({ message: 'Session stopped before dispatch' })
        );
        expect(sessionBackgroundDeliveryService.isDeliveryActive(delivery.deliveryId)).toBe(false);
        expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
      } finally {
        await sessionBackgroundDeliveryService.fail(background, new Error('test cleanup'));
      }
    }
  );

  it('recovers workspace notifications only after the PR source turn completes', async () => {
    const background: QueuedMessage = {
      ...queuedMessage,
      id: 'pr-event-queued',
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
    };
    const trace: string[] = [];
    mockSessionDomainService.peekNextMessage.mockReturnValue(background);
    mockSessionDomainService.dequeueNext.mockImplementation(() => {
      mockSessionDomainService.peekNextMessage.mockReturnValue(undefined);
      return background;
    });
    mockSessionDomainService.getPendingInteractiveRequest.mockReturnValue(null);
    mockSessionService.getSessionClient.mockReturnValue({ providerSessionId: 'existing' });
    mockSessionService.sendSessionMessage.mockImplementation(() => {
      trace.push('source-turn');
      return Promise.resolve();
    });
    mockNotificationDeliveryService.recoverPending.mockImplementation(() => {
      trace.push('notification-recovery');
      return Promise.resolve({ dispatchableCount: 0 });
    });
    const prepare = vi.spyOn(sessionBackgroundDeliveryService, 'prepare').mockResolvedValue({
      status: 'ready',
      delivery: {
        deliveryId: 'd',
        sessionId: 's1',
        bindingRevision: 1,
        eventIds: ['e'],
        text: 'facts',
        attempt: 1,
      },
    });
    const validate = vi.spyOn(sessionBackgroundDeliveryService, 'validate').mockResolvedValue(true);
    const complete = vi
      .spyOn(sessionBackgroundDeliveryService, 'complete')
      .mockImplementation(() => {
        trace.push('receipt');
        return Promise.resolve();
      });
    try {
      await chatMessageHandlerService.tryDispatchNextMessage('s1');
      expect(trace).toEqual(['source-turn', 'receipt', 'notification-recovery']);
    } finally {
      prepare.mockRestore();
      validate.mockRestore();
      complete.mockRestore();
    }
  });

  it.each(['working', 'compacting'] as const)(
    'defers a PR delivery when the provider becomes %s during preparation',
    async (busy) => {
      const background: QueuedMessage = {
        ...queuedMessage,
        id: 'pr-event-queued',
        source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
      };
      mockSessionDomainService.peekNextMessage.mockReturnValue(background);
      mockSessionDomainService.getPendingInteractiveRequest.mockReturnValue(null);
      const client = {
        isCompactingActive: () => busy === 'compacting',
        startCompaction: vi.fn(),
        endCompaction: vi.fn(),
      };
      mockSessionService.getSessionClient.mockReturnValue(client);
      const prepare = vi
        .spyOn(sessionBackgroundDeliveryService, 'prepare')
        .mockImplementation(() => {
          if (busy === 'working') {
            mockSessionService.isSessionWorking.mockReturnValue(true);
          }
          return Promise.resolve({
            status: 'ready' as const,
            delivery: {
              deliveryId: 'd',
              sessionId: 's1',
              bindingRevision: 1,
              eventIds: ['e'],
              text: 'facts',
              attempt: 1,
            },
          });
        });
      const fail = vi.spyOn(sessionBackgroundDeliveryService, 'fail').mockResolvedValue();
      try {
        await chatMessageHandlerService.tryDispatchNextMessage('s1');
        expect(fail).toHaveBeenCalledWith(
          background,
          expect.objectContaining({
            message: expect.stringContaining('A turn is already in progress'),
          })
        );
        expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
        expect(mockSessionDomainService.removeQueuedMessage).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
        fail.mockRestore();
      }
    }
  );
  it('verifies strict startup even when a provider handle is already installed', async () => {
    const background: QueuedMessage = {
      ...queuedMessage,
      id: 'pr-event-queued',
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
    };
    mockSessionDomainService.peekNextMessage.mockReturnValue(background);
    mockSessionDomainService.getPendingInteractiveRequest.mockReturnValue(null);
    mockSessionService.getSessionClient.mockReturnValue({ providerSessionId: 'fallback' });
    mockSessionService.getOrCreateSessionClient.mockRejectedValueOnce(
      new Error('Required existing conversation could not be restored')
    );
    const prepare = vi.spyOn(sessionBackgroundDeliveryService, 'prepare').mockResolvedValue({
      status: 'ready',
      delivery: {
        deliveryId: 'd',
        sessionId: 's1',
        bindingRevision: 1,
        eventIds: ['e'],
        text: 'facts',
        attempt: 1,
      },
    });
    const fail = vi.spyOn(sessionBackgroundDeliveryService, 'fail').mockResolvedValue();
    try {
      await chatMessageHandlerService.tryDispatchNextMessage('s1');
      expect(mockSessionService.getOrCreateSessionClient).toHaveBeenCalledWith('s1', {
        resumePolicy: 'require_existing',
      });
      expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledWith(
        background,
        expect.objectContaining({ message: expect.stringContaining('existing conversation') })
      );
    } finally {
      prepare.mockRestore();
      fail.mockRestore();
    }
  });

  it('dispatches a human message that arrives while a PR update is being prepared', async () => {
    const background: QueuedMessage = {
      ...queuedMessage,
      id: 'pr-event-queued',
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
    };
    mockSessionDomainService.getPendingInteractiveRequest.mockReturnValue(null);
    mockSessionDomainService.peekNextMessage.mockReturnValue(background);
    const prepare = vi
      .spyOn(sessionBackgroundDeliveryService, 'prepare')
      .mockImplementation(async () => {
        await Promise.resolve();
        mockSessionDomainService.peekNextMessage.mockReturnValue(queuedMessage);
        return {
          status: 'ready',
          delivery: {
            deliveryId: 'd',
            sessionId: 's1',
            bindingRevision: 1,
            eventIds: ['e'],
            text: 'facts',
            attempt: 1,
          },
        };
      });
    const validate = vi.spyOn(sessionBackgroundDeliveryService, 'validate').mockResolvedValue(true);
    const fail = vi.spyOn(sessionBackgroundDeliveryService, 'fail').mockResolvedValue();
    mockSessionService.getSessionClient.mockReturnValue({ providerSessionId: 'existing' });
    await chatMessageHandlerService.tryDispatchNextMessage('s1');
    expect(mockSessionService.sendSessionMessage).toHaveBeenCalledWith('s1', 'hello');
    expect(fail).toHaveBeenCalledWith(
      background,
      expect.objectContaining({ message: expect.stringContaining('human message queued') })
    );
    prepare.mockRestore();
    validate.mockRestore();
    fail.mockRestore();
  });
});
