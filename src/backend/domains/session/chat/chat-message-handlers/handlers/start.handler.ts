import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import type { StartMessageInput } from '@/shared/websocket';
import { createLogger } from '@/backend/services/logger.service';
import { sessionService } from '@/backend/services/session.service';
import type { ChatMessageHandler, HandlerRegistryDependencies } from '../types';
import { getValidModel } from '../utils';

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
      sessionDomainService.markError(sessionId);
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    await clientCreator.getOrCreate(sessionId, {
      thinkingEnabled: message.thinkingEnabled,
      planModeEnabled: message.planModeEnabled,
      model: getValidModel(message),
    });
  };
}
