import type {
  ChatMessageHandler,
  HandlerRegistryDependencies,
} from '@/backend/domains/session/chat/chat-message-handlers/types';
import type { ResumeQueuedMessagesInput } from '@/shared/websocket';

export function createResumeQueuedMessagesHandler(
  deps: HandlerRegistryDependencies
): ChatMessageHandler<ResumeQueuedMessagesInput> {
  return async ({ sessionId }) => {
    deps.setManualDispatchResume(sessionId, true);
    await deps.tryDispatchNextMessage(sessionId);
  };
}
