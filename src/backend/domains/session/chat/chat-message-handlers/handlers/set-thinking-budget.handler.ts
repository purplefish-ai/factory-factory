import { DEBUG_CHAT_WS } from '@/backend/domains/session/chat/chat-message-handlers/constants';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { createLogger } from '@/backend/services/logger.service';
import type { SetThinkingBudgetMessage } from '@/shared/websocket';
import { sendWebSocketError } from './utils';

const logger = createLogger('chat-message-handlers');

export function createSetThinkingBudgetHandler(): ChatMessageHandler<SetThinkingBudgetMessage> {
  return async ({ ws, sessionId, message }) => {
    try {
      await sessionService.setSessionThinkingBudget(sessionId, message.max_tokens);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set thinking budget', {
          sessionId,
          maxTokens: message.max_tokens,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to set thinking budget', {
        sessionId,
        maxTokens: message.max_tokens,
        error: errorMessage,
      });
      sendWebSocketError(ws, `Failed to set thinking budget: ${errorMessage}`);
    }
  };
}
