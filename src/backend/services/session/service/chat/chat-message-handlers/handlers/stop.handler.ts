import { chatEventForwarderService } from '@/backend/services/session/service/chat/chat-event-forwarder.service';
import type {
  ChatMessageHandler,
  HandlerRegistryDependencies,
} from '@/backend/services/session/service/chat/chat-message-handlers/types';
import { sessionLifecycleService } from '@/backend/services/session/service/lifecycle/session-core-services';
import type { StopMessage } from '@/shared/websocket';

export function createStopHandler(
  deps: HandlerRegistryDependencies
): ChatMessageHandler<StopMessage> {
  return async ({ sessionId }) => {
    await sessionLifecycleService.stopSession(sessionId, { reason: 'USER_STOP' });
    // Only clear pending requests here - clientEventSetup cleanup happens in the exit handler
    // to avoid race conditions where a new client is created before the old one exits
    chatEventForwarderService.clearPendingRequest(sessionId);
    // A stopped session can leave an in-flight dispatch guard stranded if the
    // provider turn never resolves after cancellation.
    deps.resetDispatchState?.(sessionId);
    // If messages were queued while stop was in-flight, retry dispatch now that
    // lifecycle state has settled.
    await deps.tryDispatchNextMessage(sessionId);
  };
}
