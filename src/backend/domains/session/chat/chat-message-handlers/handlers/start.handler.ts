import type {
  ChatMessageHandler,
  HandlerRegistryDependencies,
} from '@/backend/domains/session/chat/chat-message-handlers/types';
import {
  getValidModel,
  getValidReasoningEffort,
} from '@/backend/domains/session/chat/chat-message-handlers/utils';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { createLogger } from '@/backend/services/logger.service';
import type { StartMessageInput } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createStartHandler(
  deps: HandlerRegistryDependencies
): ChatMessageHandler<StartMessageInput> {
  return async ({ ws, sessionId, message }) => {
    const clientCreator = deps.getClientCreator();
    if (!clientCreator) {
      ws.send(JSON.stringify({ type: 'error', message: 'Client creator not configured' }));
      return;
    }
    const sessionOpts = await sessionService.getSessionOptions(sessionId);
    if (!sessionOpts) {
      logger.error('[Chat WS] Failed to get session options', { sessionId });
      sessionDomainService.markError(sessionId, 'Session not found');
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    try {
      await clientCreator.getOrCreate(sessionId, {
        thinkingEnabled: message.thinkingEnabled,
        planModeEnabled: message.planModeEnabled,
        model: getValidModel(message),
        reasoningEffort: getValidReasoningEffort(message),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to start session client', { sessionId, error: errorMessage });
      sessionDomainService.markError(sessionId, `Failed to start agent: ${errorMessage}`);
      ws.send(JSON.stringify({ type: 'error', message: `Failed to start agent: ${errorMessage}` }));
    }
  };
}
