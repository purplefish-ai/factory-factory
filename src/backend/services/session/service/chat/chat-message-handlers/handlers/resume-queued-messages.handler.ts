import type {
  SessionCommandHandler,
  SessionExecutionCommandServices,
} from '@/backend/services/session/service/chat/session-command.types';
import type { ResumeQueuedMessagesInput } from '@/shared/websocket';

export function createResumeQueuedMessagesHandler(
  deps: Pick<SessionExecutionCommandServices, 'backgroundDelivery'> & {
    tryDispatchNextMessage: (sessionId: string) => Promise<void>;
    setManualDispatchResume: (sessionId: string, resumed: boolean) => void;
  }
): SessionCommandHandler<ResumeQueuedMessagesInput> {
  return async ({ sessionId }) => {
    const isCurrent = deps.backgroundDelivery.captureResumeGuard(sessionId);
    await deps.backgroundDelivery.userResume(sessionId, isCurrent);
    if (!isCurrent()) {
      return { replies: [] };
    }
    deps.setManualDispatchResume(sessionId, true);
    await deps.tryDispatchNextMessage(sessionId);
    return { replies: [] };
  };
}
