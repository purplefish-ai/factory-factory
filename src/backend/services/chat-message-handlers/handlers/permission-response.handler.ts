import type { PermissionResponseMessage } from '@/shared/websocket';
import { chatEventForwarderService } from '../../chat-event-forwarder.service';
import { sessionService } from '../../session.service';
import { DEBUG_CHAT_WS } from '../constants';
import { createLogger } from '../../logger.service';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createPermissionResponseHandler(): ChatMessageHandler {
  return ({ ws, sessionId, message }) => {
    const typedMessage = message as PermissionResponseMessage;
    const { requestId, allow } = typedMessage;

    const client = sessionService.getClient(sessionId);
    if (!client) {
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      if (allow) {
        client.approveInteractiveRequest(requestId);
      } else {
        client.denyInteractiveRequest(requestId, 'User denied');
      }
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Responded to permission request', { sessionId, requestId, allow });
      }
    } catch (error) {
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
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
