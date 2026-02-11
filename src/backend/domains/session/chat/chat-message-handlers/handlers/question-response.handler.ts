import { createLogger } from '@/backend/services/logger.service';
import type { QuestionResponseMessage } from '@/shared/websocket';
import { DEBUG_CHAT_WS } from '../constants';
import type { ChatMessageHandler } from '../types';
import { clearPendingInteractiveRequest, getClientOrSendError, sendWebSocketError } from './utils';

const logger = createLogger('chat-message-handlers');

export function createQuestionResponseHandler(): ChatMessageHandler<QuestionResponseMessage> {
  return ({ ws, sessionId, message }) => {
    const { requestId, answers } = message;

    const client = getClientOrSendError({ sessionId, ws, requestId });
    if (!client) {
      return;
    }

    try {
      client.answerQuestion(requestId, answers);
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
