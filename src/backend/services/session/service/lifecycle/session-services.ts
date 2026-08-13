import { ChatMessageHandlerService } from '@/backend/services/session/service/chat/chat-message-handlers.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { workspaceNotificationService } from '@/backend/services/workspace';
import {
  acpEventProcessor,
  sessionConfigService,
  sessionLifecycleEventService,
  sessionLifecycleGate,
  sessionLifecycleService,
  sessionPermissionService,
  sessionPromptTurnCompletionService,
  sessionRetryService,
  sessionService,
} from './session-core-services';
import { SessionNotificationDeliveryService } from './session-notification-delivery.service';

export type { SessionPromptService } from './session-core-services';
export {
  acpEventProcessor,
  sessionConfigService,
  sessionLifecycleEventService,
  sessionLifecycleService,
  sessionPermissionService,
  sessionPromptTurnCompletionService,
  sessionRetryService,
  sessionService,
};

const sessionNotificationDeliveryService = new SessionNotificationDeliveryService({
  notificationPort: workspaceNotificationService,
  queuePort: sessionDomainService,
  transcriptPort: sessionDomainService,
  deltaPort: sessionDomainService,
});

sessionLifecycleService.configureNotificationDelivery(sessionNotificationDeliveryService);

export const chatMessageHandlerService = new ChatMessageHandlerService();

chatMessageHandlerService.configureLifecycle({
  gate: sessionLifecycleGate,
  notificationDelivery: sessionNotificationDeliveryService,
  startup: {
    getSessionClient: (sessionId) => sessionLifecycleService.getSessionClient(sessionId),
    getOrCreateSessionClient: (sessionId, options) =>
      sessionLifecycleService.getOrCreateSessionClient(sessionId, {
        thinkingEnabled: options.thinkingEnabled,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      }),
  },
});
