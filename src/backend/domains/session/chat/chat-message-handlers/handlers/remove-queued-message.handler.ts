import { DEBUG_CHAT_WS } from '@/backend/domains/session/chat/chat-message-handlers/constants';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { createLogger } from '@/backend/services/logger.service';
import { MessageState } from '@/shared/acp-protocol';
import type { RemoveQueuedMessageInput } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createRemoveQueuedMessageHandler(): ChatMessageHandler<RemoveQueuedMessageInput> {
  return ({ ws, sessionId, message }) => {
    const { messageId } = message;
    const removed = sessionDomainService.removeQueuedMessage(sessionId, messageId);

    if (removed) {
      sessionDomainService.emitDelta(sessionId, {
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
