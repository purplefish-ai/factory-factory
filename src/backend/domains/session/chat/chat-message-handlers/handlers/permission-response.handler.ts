import { DEBUG_CHAT_WS } from '@/backend/domains/session/chat/chat-message-handlers/constants';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { createLogger } from '@/backend/services/logger.service';
import type { PermissionResponseMessage } from '@/shared/websocket';
import { clearPendingInteractiveRequest, getClientOrSendError, sendWebSocketError } from './utils';

const logger = createLogger('chat-message-handlers');

export function createPermissionResponseHandler(): ChatMessageHandler<PermissionResponseMessage> {
  return ({ ws, sessionId, message }) => {
    const { requestId, allow } = message;

    const client = getClientOrSendError({ sessionId, ws, requestId });
    if (!client) {
      return;
    }

    try {
      if (allow) {
        client.approveInteractiveRequest(requestId);
      } else {
        client.denyInteractiveRequest(requestId, 'User denied');
      }
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Responded to permission request', { sessionId, requestId, allow });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to respond to permission request', {
        sessionId,
        requestId,
        error: errorMessage,
      });
      sendWebSocketError(ws, `Failed to respond to permission: ${errorMessage}`);
    } finally {
      clearPendingInteractiveRequest(sessionId, requestId);
    }
  };
}
