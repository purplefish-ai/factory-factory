import { createLogger } from '@/backend/services/logger.service';
import { DEBUG_CHAT_WS } from '@/backend/services/session/service/chat/chat-message-handlers/constants';
import type {
  SessionCommandHandler,
  SessionCommandOutcome,
  SessionExecutionCommandServices,
} from '@/backend/services/session/service/chat/session-command.types';
import { MessageState } from '@/shared/acp-protocol';
import type { RemoveQueuedMessageInput } from '@/shared/websocket';
import type { SessionChatIntentService } from '../../session-chat-intent.service';

const logger = createLogger('chat-message-handlers');

export function createRemoveQueuedMessageHandler(deps: {
  chatIntent?: Pick<SessionChatIntentService, 'cancelQueued'>;
  domain: Pick<
    SessionExecutionCommandServices['domain'],
    'removeQueuedMessage' | 'emitDelta' | 'chatIntent'
  >;
}): SessionCommandHandler<RemoveQueuedMessageInput> {
  return ({ sessionId }, message) => {
    const { messageId } = message;
    if (messageId.startsWith('pr-event-')) {
      return { replies: [{ type: 'error', error: { kind: 'background_monitoring_required' } }] };
    }
    const publish = (removed: boolean): SessionCommandOutcome => {
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
    return deps.chatIntent
      ? deps.chatIntent.cancelQueued(sessionId, messageId).then(publish)
      : publish(deps.domain.removeQueuedMessage(sessionId, messageId));
  };
}
