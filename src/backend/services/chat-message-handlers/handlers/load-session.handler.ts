import type { WebSocket } from 'ws';
import type { LoadSessionMessage } from '@/shared/websocket';
import { SessionManager } from '../../../claude/index';
import { claudeSessionAccessor } from '../../../resource_accessors/claude-session.accessor';
import { chatConnectionService } from '../../chat-connection.service';
import { chatEventForwarderService } from '../../chat-event-forwarder.service';
import { messageStateService } from '../../message-state.service';
import { sessionService } from '../../session.service';
import { sessionRuntimeStoreService } from '../../session-runtime-store.service';
import { slashCommandCacheService } from '../../slash-command-cache.service';
import type { ChatMessageHandler } from '../types';

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

  const pendingRequest = chatEventForwarderService.getPendingRequest(sessionId);
  messageStateService.sendSnapshot(sessionId, {
    loadRequestId,
    pendingInteractiveRequest: pendingRequest
      ? {
          requestId: pendingRequest.requestId,
          toolName: pendingRequest.toolName,
          input: pendingRequest.input,
          planContent: pendingRequest.planContent,
          timestamp: pendingRequest.timestamp,
        }
      : null,
  });

  // Runtime snapshot is still sent directly to the reconnecting client so
  // lifecycle state (running/stopping/idle) updates immediately.
  ws.send(
    JSON.stringify({
      type: 'session_runtime_snapshot',
      sessionRuntime,
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
