import type { QuestionResponseMessage } from '@/shared/websocket';
import { chatEventForwarderService } from '../../chat-event-forwarder.service';
import { createLogger } from '../../logger.service';
import { sessionService } from '../../session.service';
import { DEBUG_CHAT_WS } from '../constants';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createQuestionResponseHandler(): ChatMessageHandler {
  return ({ ws, sessionId, message }) => {
    const typedMessage = message as QuestionResponseMessage;
    const { requestId, answers } = typedMessage;

    const client = sessionService.getClient(sessionId);
    if (!client) {
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
      ws.send(JSON.stringify({ type: 'error', message: 'No active client for session' }));
      return;
    }

    try {
      client.answerQuestion(requestId, answers);
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Answered question', { sessionId, requestId });
      }
    } catch (error) {
      chatEventForwarderService.clearPendingRequestIfMatches(sessionId, requestId);
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
