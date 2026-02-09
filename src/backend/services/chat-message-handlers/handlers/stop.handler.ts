import type { StopMessage } from '@/shared/websocket';
import { chatEventForwarderService } from '../../chat-event-forwarder.service';
import { sessionService } from '../../session.service';
import { sessionStoreService } from '../../session-store.service';
import type { ChatMessageHandler } from '../types';

export function createStopHandler(): ChatMessageHandler<StopMessage> {
  return async ({ sessionId }) => {
    const existingClient = sessionService.getClient(sessionId);
    sessionStoreService.markStopping(sessionId);
    await sessionService.stopClaudeSession(sessionId);
    // Only clear pending requests here - clientEventSetup cleanup happens in the exit handler
    // to avoid race conditions where a new client is created before the old one exits
    chatEventForwarderService.clearPendingRequest(sessionId);
    if (!existingClient) {
      sessionStoreService.markIdle(sessionId, 'stopped');
    }
  };
}
