import { createLogger } from '@/backend/services/logger.service';
import type { SetModelMessage } from '@/shared/websocket';
import { sessionService } from '../../../lifecycle/session.service';
import { DEBUG_CHAT_WS } from '../constants';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createSetModelHandler(): ChatMessageHandler<SetModelMessage> {
  return async ({ ws, sessionId, message }) => {
    const client = sessionService.getClient(sessionId);
    if (!client) {
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      await client.setModel(message.model);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set model', { sessionId, model: message.model });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to set model', {
        sessionId,
        model: message.model,
        error: errorMessage,
      });
      ws.send(JSON.stringify({ type: 'error', message: `Failed to set model: ${errorMessage}` }));
    }
  };
}
