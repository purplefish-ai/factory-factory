import type { ResumeQueuedMessagesInput } from '@/shared/websocket';
import type { ChatMessageHandler, HandlerRegistryDependencies } from '../types';

export function createResumeQueuedMessagesHandler(
  deps: HandlerRegistryDependencies
): ChatMessageHandler<ResumeQueuedMessagesInput> {
  return async ({ sessionId }) => {
    deps.setManualDispatchResume(sessionId, true);
    await deps.tryDispatchNextMessage(sessionId);
  };
}
