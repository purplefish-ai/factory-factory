import { createLogger } from '@/backend/services/logger.service';
import type { ChatMessageHandlerStartupService } from '@/backend/services/session/service/chat/chat-message-handlers/types';
import {
  getValidModel,
  getValidReasoningEffort,
} from '@/backend/services/session/service/chat/chat-message-handlers/utils';
import type {
  SessionCommandHandler,
  SessionExecutionCommandServices,
} from '@/backend/services/session/service/chat/session-command.types';
import { WorkspaceStatus } from '@/shared/core';
import type { StartMessageInput } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createStartHandler(
  deps: Pick<SessionExecutionCommandServices, 'backgroundDelivery'> & {
    domain: Pick<SessionExecutionCommandServices['domain'], 'markError'>;
    lifecycle: Pick<SessionExecutionCommandServices['lifecycle'], 'getSessionOptions'>;
    startupService: ChatMessageHandlerStartupService;
  }
): SessionCommandHandler<StartMessageInput> {
  return async ({ sessionId }, message) => {
    const isCurrent = deps.backgroundDelivery.captureResumeGuard(sessionId);
    const sessionOpts = await deps.lifecycle.getSessionOptions(sessionId);
    if (!sessionOpts) {
      logger.error('[Chat WS] Failed to get session options', { sessionId });
      deps.domain.markError(sessionId, 'Session not found');
      return { replies: [{ type: 'error', error: { kind: 'session_not_found' } }] };
    }
    if (
      sessionOpts.workspaceStatus === WorkspaceStatus.ARCHIVING ||
      sessionOpts.workspaceStatus === WorkspaceStatus.ARCHIVED
    ) {
      return { replies: [{ type: 'error', error: { kind: 'workspace_archived' } }] };
    }

    try {
      await deps.startupService.getOrCreateSessionClient(sessionId, {
        thinkingEnabled: message.thinkingEnabled,
        planModeEnabled: message.planModeEnabled,
        model: getValidModel(message),
        reasoningEffort: getValidReasoningEffort(message),
      });
      void deps.backgroundDelivery.userResume(sessionId, isCurrent).catch((error) => {
        logger.warn('Failed to resume PR delivery after session startup', { sessionId, error });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to start session client', { sessionId, error: errorMessage });
      deps.domain.markError(sessionId, `Failed to start agent: ${errorMessage}`);
      return { replies: [{ type: 'error', error: { kind: 'start_failed', cause: error } }] };
    }
    return { replies: [] };
  };
}
