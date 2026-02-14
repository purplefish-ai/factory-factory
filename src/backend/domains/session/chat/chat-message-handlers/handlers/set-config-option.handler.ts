import { DEBUG_CHAT_WS } from '@/backend/domains/session/chat/chat-message-handlers/constants';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { createLogger } from '@/backend/services/logger.service';
import type { SetConfigOptionMessage } from '@/shared/websocket';
import { sendWebSocketError } from './utils';

const logger = createLogger('chat-message-handlers');

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; code?: unknown; data?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      return candidate.message;
    }
    if (typeof candidate.data !== 'undefined') {
      try {
        return JSON.stringify(candidate.data);
      } catch {
        // Fall through to generic object serialization
      }
    }
    if (typeof candidate.code === 'number' || typeof candidate.code === 'string') {
      return `ACP error (${String(candidate.code)})`;
    }
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

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
      const errorMessage = getErrorMessage(error);
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
