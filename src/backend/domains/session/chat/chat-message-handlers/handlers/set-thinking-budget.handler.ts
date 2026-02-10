import { createLogger } from '@/backend/services/logger.service';
import type { SetThinkingBudgetMessage } from '@/shared/websocket';
import { sessionService } from '../../../lifecycle/session.service';
import { DEBUG_CHAT_WS } from '../constants';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createSetThinkingBudgetHandler(): ChatMessageHandler<SetThinkingBudgetMessage> {
  return async ({ ws, sessionId, message }) => {
    const client = sessionService.getClient(sessionId);
    if (!client) {
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      await client.setMaxThinkingTokens(message.max_tokens);
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
      ws.send(
        JSON.stringify({ type: 'error', message: `Failed to set thinking budget: ${errorMessage}` })
      );
    }
  };
}
