import type { WebSocket } from 'ws';
import type { LoadSessionMessage } from '@/shared/websocket';
import { SessionManager } from '../../../claude/index';
import { claudeSessionAccessor } from '../../../resource_accessors/claude-session.accessor';
import {
  AskUserQuestionInputSchema,
  safeParseToolInput,
} from '../../../schemas/tool-inputs.schema';
import { chatConnectionService } from '../../chat-connection.service';
import { chatEventForwarderService } from '../../chat-event-forwarder.service';
import { eventCompressionService } from '../../event-compression.service';
import { createLogger } from '../../logger.service';
import { messageStateService } from '../../message-state.service';
import { sessionService } from '../../session.service';
import { sessionRuntimeStoreService } from '../../session-runtime-store.service';
import { slashCommandCacheService } from '../../slash-command-cache.service';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createLoadSessionHandler(): ChatMessageHandler<LoadSessionMessage> {
  return async ({ ws, sessionId, workingDir, message }) => {
    const dbSession = await claudeSessionAccessor.findById(sessionId);
    if (!dbSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    const existingClient = sessionService.getClient(sessionId);

    if (existingClient?.isRunning()) {
      replayEventsForRunningClient(ws, sessionId, existingClient, message.loadRequestId);
    } else {
      await loadHistoryFromJSONL(
        sessionId,
        workingDir,
        dbSession.claudeSessionId,
        message.loadRequestId
      );
    }

    await sendCachedSlashCommandsIfNeeded(sessionId);
  };
}

/**
 * Replay stored events to a reconnecting client when Claude is still running.
 * Uses event compression to reduce the number of messages sent on reconnect.
 */
function replayEventsForRunningClient(
  ws: WebSocket,
  sessionId: string,
  client: { isWorking: () => boolean; isRunning: () => boolean },
  loadRequestId?: string
): void {
  const sessionRuntime = sessionRuntimeStoreService.syncFromClient(sessionId, {
    isRunning: client.isRunning(),
    isWorking: client.isWorking(),
  });

  // Get stored events and compress for efficient replay
  const events = messageStateService.getStoredEvents(sessionId);
  const { compressed, stats } = eventCompressionService.compressWithStats(events);

  // Log compression stats if significant compression occurred
  if (stats.originalCount > stats.compressedCount) {
    eventCompressionService.logCompressionStats(sessionId, stats);
  }

  const replayEvents: Record<string, unknown>[] = compressed.map((event) => ({ ...event }));

  // Always replay deterministic runtime snapshot before deltas.
  replayEvents.unshift({
    type: 'session_runtime_snapshot',
    sessionRuntime,
  });

  // Send pending interactive request if any
  const pendingRequest = chatEventForwarderService.getPendingRequest(sessionId);
  if (pendingRequest) {
    const interactiveEvent = createPendingInteractiveRequestEvent(pendingRequest);
    if (interactiveEvent) {
      replayEvents.push(interactiveEvent);
    }
  }

  ws.send(
    JSON.stringify({
      type: 'session_replay_batch',
      replayEvents,
      loadRequestId,
    })
  );
}

/**
 * Build an interactive request event in the appropriate format.
 */
function createPendingInteractiveRequestEvent(
  pendingRequest: NonNullable<ReturnType<typeof chatEventForwarderService.getPendingRequest>>
): Record<string, unknown> | null {
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
      return {
        type: 'error',
        message: 'Unable to restore question prompt - invalid format',
      };
    }

    return {
      type: 'user_question',
      requestId: pendingRequest.requestId,
      questions: parsed.data.questions,
    };
  }

  if (pendingRequest.toolName === 'ExitPlanMode') {
    return {
      type: 'permission_request',
      requestId: pendingRequest.requestId,
      toolName: pendingRequest.toolName,
      toolInput: pendingRequest.input,
      planContent: pendingRequest.planContent,
    };
  }

  // Generic interactive request fallback
  return {
    type: 'interactive_request',
    requestId: pendingRequest.requestId,
    toolName: pendingRequest.toolName,
    toolUseId: pendingRequest.toolUseId,
    toolInput: pendingRequest.input,
  };
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
  claudeSessionId: string | null,
  loadRequestId?: string
): Promise<void> {
  if (claudeSessionId) {
    const history = await SessionManager.getHistory(claudeSessionId, workingDir);
    messageStateService.ensureHistoryLoaded(sessionId, history);
  }
  sessionRuntimeStoreService.markIdle(sessionId, 'stopped');
  messageStateService.sendSnapshot(sessionId, {
    loadRequestId,
    pendingInteractiveRequest: null,
  });
  sessionRuntimeStoreService.emitSnapshot(sessionId);
}

async function sendCachedSlashCommandsIfNeeded(sessionId: string): Promise<void> {
  const cached = await slashCommandCacheService.getCachedCommands();
  if (!cached || cached.length === 0) {
    return;
  }

  const storedEvents = messageStateService.getStoredEvents(sessionId);
  const hasSlashCommands = storedEvents.some((event) => event.type === 'slash_commands');
  if (hasSlashCommands) {
    return;
  }

  const slashCommandsMsg = {
    type: 'slash_commands',
    slashCommands: cached,
  };
  messageStateService.storeEvent(sessionId, slashCommandsMsg);
  chatConnectionService.forwardToSession(sessionId, slashCommandsMsg);
}
