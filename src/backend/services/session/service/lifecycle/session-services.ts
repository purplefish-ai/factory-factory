import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import { ChatMessageHandlerService } from '@/backend/services/session/service/chat/chat-message-handlers.service';
import { SessionDispatchService } from '@/backend/services/session/service/dispatch/session-dispatch.service';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import {
  acpEventProcessor,
  claudeModelCatalogService,
  codexModelCatalogService,
  providerUsageService,
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
  providerUsageService,
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
export const chatMessageHandlerService = new ChatMessageHandlerService(sessionDispatchService);

chatMessageHandlerService.configureLifecycle({
  gate: sessionLifecycleGate,
  notificationDelivery: sessionNotificationDeliveryService,
  startup: {
    getSessionClient: (sessionId) => sessionLifecycleService.getSessionClient(sessionId),
    getOrCreateSessionClient: (sessionId, options) =>
      sessionLifecycleService.getOrCreateSessionClient(sessionId, {
        resumePolicy: options.resumePolicy,
        thinkingEnabled: options.thinkingEnabled,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      }),
  },
});
