import type {
  SessionCommandHandler,
  SessionExecutionCommandServices,
} from '@/backend/services/session/service/chat/session-command.types';
import type { StopMessage } from '@/shared/websocket';

export function createStopHandler(
  deps: Pick<SessionExecutionCommandServices, 'clearPendingRequest'> & {
    lifecycle: Pick<SessionExecutionCommandServices['lifecycle'], 'stopSession'>;
    resetDispatchState?: (sessionId: string) => void;
    tryDispatchNextMessage: (sessionId: string) => Promise<void>;
  }
): SessionCommandHandler<StopMessage> {
  return async ({ sessionId }) => {
    await deps.lifecycle.stopSession(sessionId, { reason: 'USER_STOP' });
    // Only clear pending requests here - clientEventSetup cleanup happens in the exit handler
    // to avoid race conditions where a new client is created before the old one exits
    deps.clearPendingRequest(sessionId);
    // A stopped session can leave an in-flight dispatch guard stranded if the
    // provider turn never resolves after cancellation.
    deps.resetDispatchState?.(sessionId);
    // If messages were queued while stop was in-flight, retry dispatch now that
    // lifecycle state has settled.
    await deps.tryDispatchNextMessage(sessionId);
    return { replies: [] };
  };
}
