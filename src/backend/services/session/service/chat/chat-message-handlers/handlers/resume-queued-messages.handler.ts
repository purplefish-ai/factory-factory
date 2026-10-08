import type {
  ChatMessageHandler,
  HandlerRegistryDependencies,
} from '@/backend/services/session/service/chat/chat-message-handlers/types';
import type { ResumeQueuedMessagesInput } from '@/shared/websocket';
import { sessionBackgroundDeliveryService } from '../../../lifecycle/session-background-delivery.service';

export function createResumeQueuedMessagesHandler(
  deps: HandlerRegistryDependencies
): ChatMessageHandler<ResumeQueuedMessagesInput> {
  return async ({ sessionId }) => {
    await sessionBackgroundDeliveryService.userResume(sessionId);
    deps.setManualDispatchResume(sessionId, true);
    await deps.tryDispatchNextMessage(sessionId);
  };
}
