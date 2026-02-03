import { MessageState } from '@/lib/claude-types';
import type { RemoveQueuedMessageInput } from '../../../schemas/websocket';
import { messageQueueService } from '../../message-queue.service';
import { messageStateService } from '../../message-state.service';
import { DEBUG_CHAT_WS, logger } from '../constants';
import type { ChatMessageHandler } from '../types';

export function createRemoveQueuedMessageHandler(): ChatMessageHandler {
  return ({ ws, sessionId, message }) => {
    const typedMessage = message as RemoveQueuedMessageInput;
    const { messageId } = typedMessage;
    const removed = messageQueueService.remove(sessionId, messageId);

    if (removed) {
      // Transition to CANCELLED state - emits message_state_changed event to all connections
      messageStateService.updateState(sessionId, messageId, MessageState.CANCELLED);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Queued message cancelled', { sessionId, messageId });
      }
    } else {
      ws.send(JSON.stringify({ type: 'error', message: 'Message not found in queue' }));
    }
  };
}
