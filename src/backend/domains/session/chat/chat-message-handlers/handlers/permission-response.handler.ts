import { DEBUG_CHAT_WS } from '@/backend/domains/session/chat/chat-message-handlers/constants';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { createLogger } from '@/backend/services/logger.service';
import type { PermissionResponseMessage } from '@/shared/websocket';
import { clearPendingInteractiveRequest, sendWebSocketError } from './utils';

const logger = createLogger('chat-message-handlers');

export function createPermissionResponseHandler(): ChatMessageHandler<PermissionResponseMessage> {
  return ({ ws, sessionId, message }) => {
    const { requestId, allow, optionId } = message;

    try {
      if (optionId) {
        // ACP permission response -- route through bridge
        const resolved = sessionService.respondToAcpPermission(sessionId, requestId, optionId);
        if (!resolved) {
          // Fallback to legacy handler if bridge doesn't have this request
          sessionService.respondToPermissionRequest(sessionId, requestId, allow);
        }
      } else {
        // Legacy Claude/Codex permission response
        sessionService.respondToPermissionRequest(sessionId, requestId, allow);
      }
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Responded to permission request', {
          sessionId,
          requestId,
          allow,
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
