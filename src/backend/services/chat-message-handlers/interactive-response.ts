import { isInteractiveResponseTool } from '@/shared/pending-request-types';
import { AskUserQuestionInputSchema, safeParseToolInput } from '../../schemas/tool-inputs.schema';
import { createLogger } from '../logger.service';
import { sessionService } from '../session.service';
import { sessionStoreService } from '../session-store.service';
import { DEBUG_CHAT_WS } from './constants';

const logger = createLogger('chat-message-handlers');

export function tryHandleAsInteractiveResponse(
  sessionId: string,
  messageId: string,
  text: string
): boolean {
  const pendingRequest = sessionStoreService.getPendingInteractiveRequest(sessionId);
  if (!pendingRequest) {
    return false;
  }
  return handleMessageAsInteractiveResponse(sessionId, messageId, text, pendingRequest);
}

function handleMessageAsInteractiveResponse(
  sessionId: string,
  messageId: string,
  text: string,
  pendingRequest: { requestId: string; toolName: string; input: Record<string, unknown> }
): boolean {
  const client = sessionService.getClient(sessionId);
  if (!client) {
    // No active client, can't respond to interactive request
    return false;
  }

  // Only handle known interactive request types
  if (!isInteractiveResponseTool(pendingRequest.toolName)) {
    return false;
  }

  try {
    if (pendingRequest.toolName === 'AskUserQuestion') {
      handleAskUserQuestionResponse(client, sessionId, pendingRequest, text);
    } else {
      // ExitPlanMode: deny with the message text as feedback
      client.denyInteractiveRequest(pendingRequest.requestId, text);
    }

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Message used as interactive response', {
        sessionId,
        messageId,
        toolName: pendingRequest.toolName,
        requestId: pendingRequest.requestId,
      });
    }

    // Clear the pending request only after successful delivery to Claude.
    sessionStoreService.clearPendingInteractiveRequestIfMatches(
      sessionId,
      pendingRequest.requestId
    );

    // Allocate an order for this message so it sorts correctly on the frontend.
    const order = sessionStoreService.allocateOrder(sessionId);

    sessionStoreService.emitDelta(sessionId, {
      type: 'message_used_as_response',
      id: messageId,
      text,
      order,
    });

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[Chat WS] Failed to handle message as interactive response', {
      sessionId,
      messageId,
      toolName: pendingRequest.toolName,
      error: errorMessage,
    });
    sessionStoreService.emitDelta(sessionId, {
      type: 'error',
      message: 'Failed to deliver interactive response. Please try again.',
    });
    // Keep the pending request so the user can retry without losing context.
    return true;
  }
}

function handleAskUserQuestionResponse(
  client: {
    answerQuestion: (requestId: string, answers: Record<string, string>) => void;
    denyInteractiveRequest: (requestId: string, reason: string) => void;
  },
  sessionId: string,
  pendingRequest: { requestId: string; input: Record<string, unknown> },
  text: string
): void {
  const parsed = safeParseToolInput(
    AskUserQuestionInputSchema,
    pendingRequest.input,
    'AskUserQuestion',
    logger
  );

  // Treat validation failure or empty questions as an error
  if (!parsed.success || parsed.data.questions.length === 0) {
    logger.warn('[Chat WS] Invalid or empty AskUserQuestion input, denying request', {
      sessionId,
      requestId: pendingRequest.requestId,
      validationSuccess: parsed.success,
    });
    client.denyInteractiveRequest(
      pendingRequest.requestId,
      'Invalid question format - unable to process response'
    );
    return;
  }

  const answers: Record<string, string> = {};
  for (const q of parsed.data.questions) {
    // Use the message text as the "Other" response for all questions
    answers[q.question] = text;
  }
  client.answerQuestion(pendingRequest.requestId, answers);
}
