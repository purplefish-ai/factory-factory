import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import { chatEventForwarderService } from '@/backend/services/session/service/chat/chat-event-forwarder.service';
import { ChatMessageHandlerService } from '@/backend/services/session/service/chat/chat-message-handlers.service';
import { createChatMessageHandlerRegistry } from '@/backend/services/session/service/chat/chat-message-handlers/registry';
import { SessionDispatchService } from '@/backend/services/session/service/dispatch/session-dispatch.service';
import type { SessionDispatchStartOptions } from '@/backend/services/session/service/dispatch/session-dispatch.types';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  acpEventProcessor,
  claudeModelCatalogService,
  codexModelCatalogService,
  sessionConfigService,
  sessionLifecycleEventService,
  sessionLifecycleGate,
  sessionLifecycleService,
  sessionNotificationDeliveryService,
  sessionPermissionService,
  sessionPromptTurnCompletionService,
  sessionRetryService,
  sessionService,
} from './session-core-services';

export type { SessionPromptService } from './session-core-services';
export {
  acpEventProcessor,
  claudeModelCatalogService,
  codexModelCatalogService,
  sessionConfigService,
  sessionLifecycleEventService,
  sessionLifecycleService,
  sessionPermissionService,
  sessionPromptTurnCompletionService,
  sessionRetryService,
  sessionService,
};

export const sessionDispatchService = new SessionDispatchService({
  runtimeManager: acpRuntimeManager,
  configService: sessionConfigService,
  promptService: sessionService,
  backgroundDelivery: sessionBackgroundDeliveryService,
});
const dispatchLifecycle = {
  gate: sessionLifecycleGate,
  notificationDelivery: sessionNotificationDeliveryService,
  startup: {
    getSessionClient: (sessionId: string) => sessionLifecycleService.getSessionClient(sessionId),
    getOrCreateSessionClient: (sessionId: string, options: SessionDispatchStartOptions) =>
      sessionLifecycleService.getOrCreateSessionClient(sessionId, {
        resumePolicy: options.resumePolicy,
        thinkingEnabled: options.thinkingEnabled,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      }),
  },
};

sessionDispatchService.configureLifecycle(dispatchLifecycle);
export const chatMessageHandlerService = new ChatMessageHandlerService(
  createChatMessageHandlerRegistry({
    executionServices: {
      domain: sessionDomainService,
      lifecycle: sessionLifecycleService,
      backgroundDelivery: sessionBackgroundDeliveryService,
      clearPendingRequest:
        chatEventForwarderService.clearPendingRequest.bind(chatEventForwarderService),
    },
    acpRuntimeManager,
    sessionConfigService,
    sessionPermissionService,
    sessionService,
    startupService: dispatchLifecycle.startup,
    tryDispatchNextMessage: (sessionId) => sessionDispatchService.tryDispatchNextMessage(sessionId),
    setManualDispatchResume: (sessionId, resumed) =>
      sessionDispatchService.setManualDispatchResume(sessionId, resumed),
    resetDispatchState: (sessionId) => sessionDispatchService.resetDispatchState(sessionId),
  })
);
