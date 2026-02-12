import { DEBUG_CHAT_WS } from '@/backend/domains/session/chat/chat-message-handlers/constants';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { createLogger } from '@/backend/services/logger.service';
import type { QuestionResponseMessage } from '@/shared/websocket';
import { clearPendingInteractiveRequest, sendWebSocketError } from './utils';

const logger = createLogger('chat-message-handlers');

export function createQuestionResponseHandler(): ChatMessageHandler<QuestionResponseMessage> {
  return ({ ws, sessionId, message }) => {
    const { requestId, answers } = message;

    try {
      sessionService.respondToQuestionRequest(sessionId, requestId, answers);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Answered question', { sessionId, requestId });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to answer question', {
        sessionId,
        requestId,
        error: errorMessage,
      });
      sendWebSocketError(ws, `Failed to answer question: ${errorMessage}`);
    } finally {
      clearPendingInteractiveRequest(sessionId, requestId);
    }
  };
}
