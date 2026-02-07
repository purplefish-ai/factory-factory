import type { GetQueueMessage } from '@/shared/websocket';
import { chatEventForwarderService } from '../../chat-event-forwarder.service';
import { messageStateService } from '../../message-state.service';
import { sessionService } from '../../session.service';
import { sessionRuntimeStoreService } from '../../session-runtime-store.service';
import type { ChatMessageHandler } from '../types';

export function createGetQueueHandler(): ChatMessageHandler<GetQueueMessage> {
  return ({ sessionId }) => {
    const existingClient = sessionService.getClient(sessionId);
    sessionRuntimeStoreService.syncFromClient(sessionId, {
      isRunning: existingClient?.isRunning() ?? false,
      isWorking: existingClient?.isWorking() ?? false,
    });
    const pendingInteractiveRequest =
      chatEventForwarderService.getPendingRequest(sessionId) ?? null;
    messageStateService.sendSnapshot(sessionId, { pendingInteractiveRequest });
    sessionRuntimeStoreService.emitSnapshot(sessionId);
  };
}
