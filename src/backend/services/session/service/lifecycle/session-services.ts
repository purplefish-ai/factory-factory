import { ChatMessageHandlerService } from '@/backend/services/session/service/chat/chat-message-handlers.service';
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

export const chatMessageHandlerService = new ChatMessageHandlerService();

chatMessageHandlerService.configureLifecycle({
  gate: sessionLifecycleGate,
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
