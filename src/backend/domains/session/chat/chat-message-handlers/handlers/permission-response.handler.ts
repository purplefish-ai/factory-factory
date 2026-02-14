import { DEBUG_CHAT_WS } from '@/backend/domains/session/chat/chat-message-handlers/constants';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { createLogger } from '@/backend/services/logger.service';
import type { PermissionResponseMessage } from '@/shared/websocket';
import { clearPendingInteractiveRequest, sendWebSocketError } from './utils';

const logger = createLogger('chat-message-handlers');

export function createPermissionResponseHandler(): ChatMessageHandler<PermissionResponseMessage> {
  return ({ ws, sessionId, message }) => {
    const { requestId, optionId } = message;

    try {
      // ACP permission response -- route through bridge
      const resolved = sessionService.respondToAcpPermission(sessionId, requestId, optionId);
      if (!resolved) {
        sendWebSocketError(ws, 'No pending ACP permission request found for this request ID');
        return;
      }
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Responded to permission request', {
          sessionId,
          requestId,
          optionId,
        });
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
