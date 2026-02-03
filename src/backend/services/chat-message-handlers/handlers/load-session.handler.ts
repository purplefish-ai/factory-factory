import type { WebSocket } from 'ws';
import { SessionManager } from '../../../claude/index';
import { claudeSessionAccessor } from '../../../resource_accessors/claude-session.accessor';
import {
  AskUserQuestionInputSchema,
  safeParseToolInput,
} from '../../../schemas/tool-inputs.schema';
import { chatEventForwarderService } from '../../chat-event-forwarder.service';
import { eventCompressionService } from '../../event-compression.service';
import { messageStateService } from '../../message-state.service';
import { sessionService } from '../../session.service';
import { createLogger } from '../../logger.service';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createLoadSessionHandler(): ChatMessageHandler {
  return async ({ ws, sessionId, workingDir }) => {
    const dbSession = await claudeSessionAccessor.findById(sessionId);
    if (!dbSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    const existingClient = sessionService.getClient(sessionId);

    if (existingClient?.isRunning()) {
      replayEventsForRunningClient(ws, sessionId, existingClient);
    } else {
      await loadHistoryFromJSONL(sessionId, workingDir, dbSession.claudeSessionId);
    }
  };
}

/**
 * Replay stored events to a reconnecting client when Claude is still running.
 * Uses event compression to reduce the number of messages sent on reconnect.
 */
function replayEventsForRunningClient(
  ws: WebSocket,
  sessionId: string,
  client: { isWorking: () => boolean }
): void {
  // Get stored events and compress for efficient replay
  const events = messageStateService.getStoredEvents(sessionId);
  const { compressed, stats } = eventCompressionService.compressWithStats(events);

  // Log compression stats if significant compression occurred
  if (stats.originalCount > stats.compressedCount) {
    eventCompressionService.logCompressionStats(sessionId, stats);
  }

  // Replay compressed events to this specific WebSocket
  for (const event of compressed) {
    ws.send(JSON.stringify(event));
  }

  // Send current status
  const isClientWorking = client.isWorking();
  ws.send(JSON.stringify({ type: 'status', running: isClientWorking }));

  // Send pending interactive request if any
  const pendingRequest = chatEventForwarderService.getPendingRequest(sessionId);
  if (pendingRequest) {
    sendPendingInteractiveRequest(ws, pendingRequest);
  }
}

/**
 * Send a pending interactive request to the WebSocket in the appropriate format.
 */
function sendPendingInteractiveRequest(
  ws: WebSocket,
  pendingRequest: NonNullable<ReturnType<typeof chatEventForwarderService.getPendingRequest>>
): void {
  if (pendingRequest.toolName === 'AskUserQuestion') {
    const parsed = safeParseToolInput(
      AskUserQuestionInputSchema,
      pendingRequest.input,
      'AskUserQuestion',
      logger
    );

    // Only send valid questions to the frontend
    if (!parsed.success || parsed.data.questions.length === 0) {
      logger.warn('[Chat WS] Cannot replay invalid AskUserQuestion request', {
        requestId: pendingRequest.requestId,
        validationSuccess: parsed.success,
      });
      // Send error event instead of empty questions
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Unable to restore question prompt - invalid format',
        })
      );
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'user_question',
        requestId: pendingRequest.requestId,
        questions: parsed.data.questions,
      })
    );
    return;
  }

  if (pendingRequest.toolName === 'ExitPlanMode') {
    ws.send(
      JSON.stringify({
        type: 'permission_request',
        requestId: pendingRequest.requestId,
        toolName: pendingRequest.toolName,
        input: pendingRequest.input,
        planContent: pendingRequest.planContent,
      })
    );
    return;
  }

  // Generic interactive request fallback
  ws.send(
    JSON.stringify({
      type: 'interactive_request',
      requestId: pendingRequest.requestId,
      toolName: pendingRequest.toolName,
      toolUseId: pendingRequest.toolUseId,
      input: pendingRequest.input,
    })
  );
}

/**
 * Load history from JSONL file and send as a messages_snapshot.
 * Used when reconnecting to a session that is not currently running.
 * Uses the existing messageStateService.loadFromHistory and sendSnapshot
 * to properly handle user messages and Claude messages.
 */
async function loadHistoryFromJSONL(
  sessionId: string,
  workingDir: string,
  claudeSessionId: string | null
): Promise<void> {
  if (claudeSessionId) {
    const history = await SessionManager.getHistory(claudeSessionId, workingDir);
    messageStateService.loadFromHistory(sessionId, history);
  }
  const sessionStatus = messageStateService.computeSessionStatus(sessionId, false);
  messageStateService.sendSnapshot(sessionId, sessionStatus, null);
}
