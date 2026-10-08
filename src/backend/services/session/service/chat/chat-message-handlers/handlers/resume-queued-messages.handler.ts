import type {
  ChatMessageHandler,
  HandlerRegistryDependencies,
} from '@/backend/services/session/service/chat/chat-message-handlers/types';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import type { ResumeQueuedMessagesInput } from '@/shared/websocket';

export function createResumeQueuedMessagesHandler(
  deps: HandlerRegistryDependencies
): ChatMessageHandler<ResumeQueuedMessagesInput> {
  return async ({ sessionId }) => {
    const isCurrent = sessionBackgroundDeliveryService.captureResumeGuard(sessionId);
    await sessionBackgroundDeliveryService.userResume(sessionId, isCurrent);
    if (!isCurrent()) {
      return;
    }
    deps.setManualDispatchResume(sessionId, true);
    await deps.tryDispatchNextMessage(sessionId);
  };
}
