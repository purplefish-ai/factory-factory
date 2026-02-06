import type { GetQueueMessage } from '@/shared/websocket';
import { chatEventForwarderService } from '../../chat-event-forwarder.service';
import { messageStateService } from '../../message-state.service';
import { sessionService } from '../../session.service';
import type { ChatMessageHandler } from '../types';

export function createGetQueueHandler(): ChatMessageHandler<GetQueueMessage> {
  return ({ sessionId }) => {
    const existingClient = sessionService.getClient(sessionId);
    const isRunning = existingClient?.isWorking() ?? false;
    const pendingInteractiveRequest =
      chatEventForwarderService.getPendingRequest(sessionId) ?? null;
    const sessionStatus = messageStateService.computeSessionStatus(sessionId, isRunning);
    messageStateService.sendSnapshot(sessionId, sessionStatus, pendingInteractiveRequest);
  };
}
