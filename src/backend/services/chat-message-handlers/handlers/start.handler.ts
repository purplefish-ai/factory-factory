import type { StartMessageInput } from '@/shared/websocket';
import { createLogger } from '../../logger.service';
import { sessionService } from '../../session.service';
import type { ChatMessageHandler, HandlerRegistryDependencies } from '../types';
import { getValidModel } from '../utils';

const logger = createLogger('chat-message-handlers');

export function createStartHandler(deps: HandlerRegistryDependencies): ChatMessageHandler {
  return async ({ ws, sessionId, message }) => {
    const clientCreator = deps.getClientCreator();
    if (!clientCreator) {
      ws.send(JSON.stringify({ type: 'error', message: 'Client creator not configured' }));
      return;
    }

    ws.send(JSON.stringify({ type: 'starting', dbSessionId: sessionId }));

    const sessionOpts = await sessionService.getSessionOptions(sessionId);
    if (!sessionOpts) {
      logger.error('[Chat WS] Failed to get session options', { sessionId });
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    await clientCreator.getOrCreate(sessionId, {
      thinkingEnabled: (message as StartMessageInput).thinkingEnabled,
      planModeEnabled: (message as StartMessageInput).planModeEnabled,
      model: getValidModel(message as StartMessageInput),
    });
    ws.send(JSON.stringify({ type: 'started', dbSessionId: sessionId }));
  };
}
