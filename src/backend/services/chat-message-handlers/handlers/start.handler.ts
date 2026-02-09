import type { StartMessageInput } from '@/shared/websocket';
import { createLogger } from '../../logger.service';
import { sessionService } from '../../session.service';
import { sessionStoreService } from '../../session-store.service';
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
    sessionStoreService.markStarting(sessionId);

    const sessionOpts = await sessionService.getSessionOptions(sessionId);
    if (!sessionOpts) {
      logger.error('[Chat WS] Failed to get session options', { sessionId });
      sessionStoreService.markError(sessionId);
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    await clientCreator.getOrCreate(sessionId, {
      thinkingEnabled: message.thinkingEnabled,
      planModeEnabled: message.planModeEnabled,
      model: getValidModel(message),
    });
    sessionStoreService.markIdle(sessionId, 'alive');
  };
}
