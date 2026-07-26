import { createLogger } from '@/backend/services/logger.service';
import { DEBUG_CHAT_WS } from '@/backend/services/session/service/chat/chat-message-handlers/constants';
import type {
  ChatMessageHandler,
  ChatMessageHandlerConfigService,
} from '@/backend/services/session/service/chat/chat-message-handlers/types';
import type { SetModelMessage } from '@/shared/websocket';
import { sendWebSocketError } from './utils';

const logger = createLogger('chat-message-handlers');

export function createSetModelHandler(deps: {
  sessionConfigService: ChatMessageHandlerConfigService;
}): ChatMessageHandler<SetModelMessage> {
  const { sessionConfigService } = deps;

  return async ({ ws, sessionId, message }) => {
    try {
      await sessionConfigService.setSessionModel(sessionId, message.model);
      if ('reasoningEffort' in message) {
        await sessionConfigService.setSessionReasoningEffort(
          sessionId,
          message.reasoningEffort ?? null
        );
      }
      const capabilities = await sessionConfigService.getChatBarCapabilities(sessionId);
      ws.send(
        JSON.stringify({
          type: 'chat_capabilities',
          capabilities,
        })
      );
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Set model', {
          sessionId,
          model: message.model,
          reasoningEffort: message.reasoningEffort,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to set model', {
        sessionId,
        model: message.model,
        reasoningEffort: message.reasoningEffort,
        error: errorMessage,
      });
      sendWebSocketError(ws, `Failed to set model: ${errorMessage}`);
    }
  };
}
