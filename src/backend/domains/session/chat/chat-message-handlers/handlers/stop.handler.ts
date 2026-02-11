import { chatEventForwarderService } from '@/backend/domains/session/chat/chat-event-forwarder.service';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import type { StopMessage } from '@/shared/websocket';

export function createStopHandler(): ChatMessageHandler<StopMessage> {
  return async ({ sessionId }) => {
    await sessionService.stopClaudeSession(sessionId);
    // Only clear pending requests here - clientEventSetup cleanup happens in the exit handler
    // to avoid race conditions where a new client is created before the old one exits
    chatEventForwarderService.clearPendingRequest(sessionId);
  };
}
