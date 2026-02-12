import { DEBUG_CHAT_WS } from '@/backend/domains/session/chat/chat-message-handlers/constants';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { createLogger } from '@/backend/services/logger.service';
import type { SetModelMessage } from '@/shared/websocket';
import { sendWebSocketError } from './utils';

const logger = createLogger('chat-message-handlers');

export function createSetModelHandler(): ChatMessageHandler<SetModelMessage> {
  return async ({ ws, sessionId, message }) => {
    try {
      await sessionService.setSessionModel(sessionId, message.model);
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
      sendWebSocketError(ws, `Failed to set model: ${errorMessage}`);
    }
  };
}
