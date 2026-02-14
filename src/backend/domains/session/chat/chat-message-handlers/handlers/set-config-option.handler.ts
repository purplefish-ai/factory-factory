import { DEBUG_CHAT_WS } from '@/backend/domains/session/chat/chat-message-handlers/constants';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { createLogger } from '@/backend/services/logger.service';
import type { SetConfigOptionMessage } from '@/shared/websocket';
import { sendWebSocketError } from './utils';

const logger = createLogger('chat-message-handlers');

export function createSetConfigOptionHandler(): ChatMessageHandler<SetConfigOptionMessage> {
  return async ({ ws, sessionId, message }) => {
    try {
      await sessionService.setSessionConfigOption(sessionId, message.configId, message.value);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set config option', {
          sessionId,
          configId: message.configId,
          value: message.value,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to set config option', {
        sessionId,
        configId: message.configId,
        value: message.value,
        error: errorMessage,
      });
      sendWebSocketError(ws, `Failed to set config option: ${errorMessage}`);
    }
  };
}
