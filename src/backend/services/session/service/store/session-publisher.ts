import { sessionFileLogger } from '@/backend/services/session/service/logging/session-file-logger.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import type { SessionDeltaEvent, WebSocketMessage } from '@/shared/acp-protocol';
import { buildSnapshotMessages } from './session-replay-builder';
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
    // Building a snapshot walks the whole transcript. Unviewed sessions skip it:
    // a client that starts viewing hydrates through load_session, which replays
    // the current store. Load replies always go out.
    if (!options?.loadRequestId && sessionEventBus.hasNoViewers(store.sessionId)) {
      return;
    }
    const snapshotMessages = buildSnapshotMessages(store);
    const payload: WebSocketMessage = {
      type: 'session_snapshot',
      messages: snapshotMessages,
      queuedMessages: [...store.queue],
      pendingInteractiveRequest: store.pendingInteractiveRequest,
      sessionRuntime: store.runtime,
      taskPlan: store.taskPlan ? structuredClone(store.taskPlan) : null,
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

    sessionEventBus.publishToSession(store.sessionId, payload);
  }

  emitDelta(sessionId: string, event: SessionDeltaEvent): void {
    const payload: WebSocketMessage = {
      type: 'session_delta',
      data: event,
    };
    sessionEventBus.publishToSession(sessionId, payload);
  }
}
