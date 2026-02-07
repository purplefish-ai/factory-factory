import type { StopMessage } from '@/shared/websocket';
import { chatEventForwarderService } from '../../chat-event-forwarder.service';
import { sessionService } from '../../session.service';
import { sessionRuntimeStoreService } from '../../session-runtime-store.service';
import type { ChatMessageHandler } from '../types';

export function createStopHandler(): ChatMessageHandler<StopMessage> {
  return async ({ sessionId }) => {
    sessionRuntimeStoreService.markStopping(sessionId);
    await sessionService.stopClaudeSession(sessionId);
    // Only clear pending requests here - clientEventSetup cleanup happens in the exit handler
    // to avoid race conditions where a new client is created before the old one exits
    chatEventForwarderService.clearPendingRequest(sessionId);
    sessionRuntimeStoreService.markIdle(sessionId, 'stopped');
  };
}
