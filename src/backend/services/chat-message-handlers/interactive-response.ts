import type { WebSocket } from 'ws';
import { INTERACTIVE_RESPONSE_TOOLS } from '@/shared/pending-request-types';
import { AskUserQuestionInputSchema, safeParseToolInput } from '../../schemas/tool-inputs.schema';
import { chatConnectionService } from '../chat-connection.service';
import { chatEventForwarderService } from '../chat-event-forwarder.service';
import { createLogger } from '../logger.service';
import { messageStateService } from '../message-state.service';
import { sessionService } from '../session.service';
import { DEBUG_CHAT_WS } from './constants';

const logger = createLogger('chat-message-handlers');

export function tryHandleAsInteractiveResponse(
  ws: WebSocket,
  sessionId: string,
  messageId: string,
  text: string
): boolean {
  const pendingRequest = chatEventForwarderService.getPendingRequest(sessionId);
  if (!pendingRequest) {
    return false;
  }
  return handleMessageAsInteractiveResponse(ws, sessionId, messageId, text, pendingRequest);
}

function handleMessageAsInteractiveResponse(
  ws: WebSocket,
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
  if (
    !INTERACTIVE_RESPONSE_TOOLS.includes(
      pendingRequest.toolName as (typeof INTERACTIVE_RESPONSE_TOOLS)[number]
    )
  ) {
    return false;
  }

  // Always clear the pending request to prevent stale state, regardless of success/failure
  // This must happen before any operation that could fail
  chatEventForwarderService.clearPendingRequestIfMatches(sessionId, pendingRequest.requestId);

  // Allocate an order for this message so it sorts correctly on the frontend
  const order = messageStateService.allocateOrder(sessionId);

  // Prepare the response event - we'll send it even on error to clear frontend state
  const responseEvent = { type: 'message_used_as_response', id: messageId, text, order };

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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[Chat WS] Failed to handle message as interactive response', {
      sessionId,
      messageId,
      toolName: pendingRequest.toolName,
      error: errorMessage,
    });
    // Continue to send the response event to clear frontend state
    // The message will be displayed in chat even though sending to Claude failed
  }

  // Always notify frontend - clears pending state and displays the message
  // This happens outside try/catch to ensure frontend state is always updated
  try {
    ws.send(JSON.stringify(responseEvent));
    chatConnectionService.forwardToSession(sessionId, responseEvent, ws);
  } catch (sendError) {
    // WebSocket send failed - frontend will recover on reconnect
    logger.warn('[Chat WS] Failed to send message_used_as_response event', {
      sessionId,
      messageId,
      error: sendError instanceof Error ? sendError.message : String(sendError),
    });
  }

  return true;
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
