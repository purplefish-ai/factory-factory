import type { SetThinkingBudgetMessage } from '../../../schemas/websocket';
import { sessionService } from '../../session.service';
import { DEBUG_CHAT_WS, logger } from '../constants';
import type { ChatMessageHandler } from '../types';

export function createSetThinkingBudgetHandler(): ChatMessageHandler {
  return async ({ ws, sessionId, message }) => {
    const typedMessage = message as SetThinkingBudgetMessage;
    const client = sessionService.getClient(sessionId);
    if (!client) {
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      await client.setMaxThinkingTokens(typedMessage.max_tokens);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set thinking budget', {
          sessionId,
          maxTokens: typedMessage.max_tokens,
        });
      }
      ws.send(JSON.stringify({ type: 'thinking_budget_set', max_tokens: typedMessage.max_tokens }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to set thinking budget', {
        sessionId,
        maxTokens: typedMessage.max_tokens,
        error: errorMessage,
      });
      ws.send(
        JSON.stringify({ type: 'error', message: `Failed to set thinking budget: ${errorMessage}` })
      );
    }
  };
}
