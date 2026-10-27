import { createLogger } from '@/backend/services/logger.service';
import { DEBUG_CHAT_WS } from '@/backend/services/session/service/chat/chat-message-handlers/constants';
import type {
  SessionCommandHandler,
  SessionExecutionCommandServices,
} from '@/backend/services/session/service/chat/session-command.types';
import { MessageState } from '@/shared/acp-protocol';
import type { RemoveQueuedMessageInput } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createRemoveQueuedMessageHandler(deps: {
  domain: Pick<SessionExecutionCommandServices['domain'], 'removeQueuedMessage' | 'emitDelta'>;
}): SessionCommandHandler<RemoveQueuedMessageInput> {
  return ({ sessionId }, message) => {
    const { messageId } = message;
    if (messageId.startsWith('pr-event-')) {
      return { replies: [{ type: 'error', error: { kind: 'background_monitoring_required' } }] };
    }
    const removed = deps.domain.removeQueuedMessage(sessionId, messageId);

    if (removed) {
      deps.domain.emitDelta(sessionId, {
        type: 'message_state_changed',
        id: messageId,
        newState: MessageState.CANCELLED,
      });
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Queued message cancelled', { sessionId, messageId });
      }
    } else {
      return { replies: [{ type: 'error', error: { kind: 'message_not_queued' } }] };
    }
    return { replies: [] };
  };
}
