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

import { sessionBackgroundDeliveryService } from '../lifecycle/session-background-delivery.service';
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
    mockSessionDomainService.getTranscriptSnapshot.mockReturnValue([]);
    mockSessionDomainService.removeQueuedMessage.mockReturnValue(true);
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
