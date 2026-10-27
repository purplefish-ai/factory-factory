import { createLogger } from '@/backend/services/logger.service';
import { DEBUG_CHAT_WS } from '@/backend/services/session/service/chat/chat-message-handlers/constants';
import type {
  SessionCommandHandler,
  SessionPermissionCommandService,
} from '@/backend/services/session/service/chat/session-command.types';
import type { PermissionResponseMessage } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createPermissionResponseHandler(deps: {
  sessionPermissionService: SessionPermissionCommandService;
}): SessionCommandHandler<PermissionResponseMessage> {
  const { sessionPermissionService } = deps;

  return ({ sessionId }, message) => {
    const { requestId, optionId, answers } = message;

    try {
      // ACP permission response -- route through bridge
      const resolved = sessionPermissionService.respondToPermission(
        sessionId,
        requestId,
        optionId,
        answers
      );
      if (!resolved) {
        return { replies: [{ type: 'error', error: { kind: 'permission_not_pending' } }] };
      }
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Responded to permission request', {
          sessionId,
          requestId,
          optionId,
          answers,
        });
      }
      return { replies: [] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to respond to permission request', {
        sessionId,
        requestId,
        error: errorMessage,
      });
      return {
        replies: [{ type: 'error', error: { kind: 'permission_response_failed', cause: error } }],
      };
    }
  };
}
