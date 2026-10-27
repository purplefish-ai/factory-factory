import { createLogger } from '@/backend/services/logger.service';
import { DEBUG_CHAT_WS } from '@/backend/services/session/service/chat/chat-message-handlers/constants';
import type {
  SessionCommandHandler,
  SessionCommandConfigService,
} from '@/backend/services/session/service/chat/session-command.types';
import type { SetThinkingBudgetMessage } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createSetThinkingBudgetHandler(deps: {
  sessionConfigService: Pick<SessionCommandConfigService, 'setSessionThinkingBudget'>;
}): SessionCommandHandler<SetThinkingBudgetMessage> {
  const { sessionConfigService } = deps;
  return async ({ sessionId }, message) => {
    try {
      await sessionConfigService.setSessionThinkingBudget(sessionId, message.max_tokens);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set thinking budget', {
          sessionId,
          maxTokens: message.max_tokens,
        });
      }
      return { replies: [] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to set thinking budget', {
        sessionId,
        maxTokens: message.max_tokens,
        error: errorMessage,
      });
      return {
        replies: [{ type: 'error', error: { kind: 'set_thinking_budget_failed', cause: error } }],
      };
    }
  };
}
