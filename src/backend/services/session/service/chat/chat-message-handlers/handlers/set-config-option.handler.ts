import { createLogger } from '@/backend/services/logger.service';
import { DEBUG_CHAT_WS } from '@/backend/services/session/service/chat/chat-message-handlers/constants';
import type {
  SessionCommandHandler,
  SessionCommandConfigService,
} from '@/backend/services/session/service/chat/session-command.types';
import type { SetConfigOptionMessage } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createSetConfigOptionHandler(deps: {
  sessionConfigService: Pick<SessionCommandConfigService, 'setSessionConfigOption'>;
}): SessionCommandHandler<SetConfigOptionMessage> {
  const { sessionConfigService } = deps;
  return async ({ sessionId }, message) => {
    try {
      await sessionConfigService.setSessionConfigOption(sessionId, message.configId, message.value);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set config option', {
          sessionId,
          configId: message.configId,
          value: message.value,
        });
      }
      return {
        replies: message.requestId
          ? [{ type: 'config_option_applied', requestId: message.requestId }]
          : [],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : error;
      logger.error('[Chat WS] Failed to set config option', {
        sessionId,
        configId: message.configId,
        value: message.value,
        error: errorMessage,
      });
      return {
        replies: [
          {
            type: 'error',
            error: { kind: 'set_config_option_failed', cause: error },
            ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
          },
        ],
      };
    }
  };
}
