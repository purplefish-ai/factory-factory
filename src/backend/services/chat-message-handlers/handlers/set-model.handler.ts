import type { SetModelMessage } from '@/shared/websocket';
import { createLogger } from '../../logger.service';
import { sessionService } from '../../session.service';
import { DEBUG_CHAT_WS } from '../constants';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createSetModelHandler(): ChatMessageHandler {
  return async ({ ws, sessionId, message }) => {
    const typedMessage = message as SetModelMessage;
    const client = sessionService.getClient(sessionId);
    if (!client) {
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      await client.setModel(typedMessage.model);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set model', { sessionId, model: typedMessage.model });
      }
      ws.send(JSON.stringify({ type: 'model_set', model: typedMessage.model }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to set model', {
        sessionId,
        model: typedMessage.model,
        error: errorMessage,
      });
      ws.send(JSON.stringify({ type: 'error', message: `Failed to set model: ${errorMessage}` }));
    }
  };
}
