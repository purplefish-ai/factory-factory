import { MessageState } from '@/shared/claude-protocol';
import type { RemoveQueuedMessageInput } from '@/shared/websocket';
import { messageQueueService } from '../../message-queue.service';
import { messageStateService } from '../../message-state.service';
import { DEBUG_CHAT_WS } from '../constants';
import { createLogger } from '../../logger.service';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

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
