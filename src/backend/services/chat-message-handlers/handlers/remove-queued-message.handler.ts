import { MessageState } from '@/shared/claude';
import type { RemoveQueuedMessageInput } from '@/shared/websocket';
import { createLogger } from '../../logger.service';
import { sessionStoreService } from '../../session-store.service';
import { DEBUG_CHAT_WS } from '../constants';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createRemoveQueuedMessageHandler(): ChatMessageHandler<RemoveQueuedMessageInput> {
  return ({ ws, sessionId, message }) => {
    const { messageId } = message;
    const removed = sessionStoreService.removeQueuedMessage(sessionId, messageId);

    if (removed) {
      sessionStoreService.emitDelta(sessionId, {
        type: 'message_state_changed',
        id: messageId,
        newState: MessageState.CANCELLED,
      });
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Queued message cancelled', { sessionId, messageId });
      }
    } else {
      ws.send(JSON.stringify({ type: 'error', message: 'Message not found in queue' }));
    }
  };
}
