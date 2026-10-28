import { createLogger } from '@/backend/services/logger.service';
import { DEBUG_CHAT_WS } from '@/backend/services/session/service/chat/chat-message-handlers/constants';
import type {
  SessionCommandHandler,
  SessionModelCommandService,
} from '@/backend/services/session/service/chat/session-command.types';
import type { SetModelMessage } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createSetModelHandler(deps: {
  sessionConfigService: SessionModelCommandService;
}): SessionCommandHandler<SetModelMessage> {
  const { sessionConfigService } = deps;

  return async ({ sessionId }, message) => {
    try {
      await sessionConfigService.setSessionModel(sessionId, message.model, 'user');
      if ('reasoningEffort' in message) {
        await sessionConfigService.setSessionReasoningEffort(
          sessionId,
          message.reasoningEffort ?? null,
          'user'
        );
      }
      const capabilities = await sessionConfigService.getChatBarCapabilities(sessionId);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set model', {
          sessionId,
          model: message.model,
          reasoningEffort: message.reasoningEffort,
        });
      }
      return { replies: [{ type: 'chat_capabilities', capabilities }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to set model', {
        sessionId,
        model: message.model,
        reasoningEffort: message.reasoningEffort,
        error: errorMessage,
      });
      return {
        replies: [
          {
            type: 'error',
            error: { kind: 'set_model_failed', cause: error },
            ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
          },
        ],
      };
    }
  };
}
