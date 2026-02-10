import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { createLogger } from '@/backend/services/logger.service';
import type { PermissionResponseMessage } from '@/shared/websocket';
import { sessionService } from '../../../lifecycle/session.service';
import { DEBUG_CHAT_WS } from '../constants';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createPermissionResponseHandler(): ChatMessageHandler<PermissionResponseMessage> {
  return ({ ws, sessionId, message }) => {
    const { requestId, allow } = message;

    const client = sessionService.getClient(sessionId);
    if (!client) {
      sessionDomainService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      if (allow) {
        client.approveInteractiveRequest(requestId);
      } else {
        client.denyInteractiveRequest(requestId, 'User denied');
      }
      sessionDomainService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Responded to permission request', { sessionId, requestId, allow });
      }
    } catch (error) {
      sessionDomainService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to respond to permission request', {
        sessionId,
        requestId,
        error: errorMessage,
      });
      ws.send(
        JSON.stringify({
          type: 'error',
          message: `Failed to respond to permission: ${errorMessage}`,
        })
      );
    }
  };
}
