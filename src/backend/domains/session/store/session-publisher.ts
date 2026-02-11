import { chatConnectionService } from '@/backend/domains/session/chat/chat-connection.service';
import { sessionFileLogger } from '@/backend/domains/session/logging/session-file-logger.service';
import type { SessionDeltaEvent, WebSocketMessage } from '@/shared/claude';
import { buildReplayEvents, buildSnapshotMessages } from './session-replay-builder';
import type { SessionStore, SnapshotReason } from './session-store.types';
import { normalizeTranscript } from './session-transcript';

export class SessionPublisher {
  private logParityTrace(sessionId: string, data: Record<string, unknown>): void {
    sessionFileLogger.log(sessionId, 'INFO', {
      type: 'parity_trace',
      ...data,
    });
  }

  getParityLogger(): (sessionId: string, data: Record<string, unknown>) => void {
    return (sessionId: string, data: Record<string, unknown>) => {
      this.logParityTrace(sessionId, data);
    };
  }

  forwardSnapshot(
    store: SessionStore,
    options?: { loadRequestId?: string; reason?: SnapshotReason; includeParitySnapshot?: boolean }
  ): void {
    const snapshotMessages = buildSnapshotMessages(store);
    const payload: WebSocketMessage = {
      type: 'session_snapshot',
      messages: snapshotMessages,
      queuedMessages: [...store.queue],
      pendingInteractiveRequest: store.pendingInteractiveRequest,
      sessionRuntime: store.runtime,
      ...(options?.loadRequestId ? { loadRequestId: options.loadRequestId } : {}),
    };

    if (options?.includeParitySnapshot) {
      this.logParityTrace(store.sessionId, {
        path: 'snapshot',
        reason: options.reason ?? 'manual_emit',
        loadRequestId: options.loadRequestId ?? null,
        queuedCount: store.queue.length,
        snapshot: normalizeTranscript(snapshotMessages),
      });
    }

    chatConnectionService.forwardToSession(store.sessionId, payload);
  }

  forwardReplayBatch(
    store: SessionStore,
    options?: { loadRequestId?: string; reason?: SnapshotReason; includeParitySnapshot?: boolean }
  ): void {
    const replayEvents = buildReplayEvents(store);
    const payload: WebSocketMessage = {
      type: 'session_replay_batch',
      replayEvents,
      ...(options?.loadRequestId ? { loadRequestId: options.loadRequestId } : {}),
    };

    if (options?.includeParitySnapshot) {
      this.logParityTrace(store.sessionId, {
        path: 'replay_batch',
        reason: options.reason ?? 'manual_emit',
        loadRequestId: options.loadRequestId ?? null,
        replayEventCount: replayEvents.length,
      });
    }

    chatConnectionService.forwardToSession(store.sessionId, payload);
  }

  emitDelta(sessionId: string, event: SessionDeltaEvent): void {
    const payload: WebSocketMessage = {
      type: 'session_delta',
      data: event,
    };
    chatConnectionService.forwardToSession(sessionId, payload);
  }
}
