import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import type { QuestionResponseMessage } from '@/shared/websocket';
import { createLogger } from '@/backend/services/logger.service';
import { sessionService } from '@/backend/services/session.service';
import { DEBUG_CHAT_WS } from '../constants';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createQuestionResponseHandler(): ChatMessageHandler<QuestionResponseMessage> {
  return ({ ws, sessionId, message }) => {
    const { requestId, answers } = message;

    const client = sessionService.getClient(sessionId);
    if (!client) {
      sessionDomainService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      client.answerQuestion(requestId, answers);
      sessionDomainService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Answered question', { sessionId, requestId });
      }
    } catch (error) {
      sessionDomainService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to answer question', {
        sessionId,
        requestId,
        error: errorMessage,
      });
      ws.send(
        JSON.stringify({ type: 'error', message: `Failed to answer question: ${errorMessage}` })
      );
    }
  };
}
