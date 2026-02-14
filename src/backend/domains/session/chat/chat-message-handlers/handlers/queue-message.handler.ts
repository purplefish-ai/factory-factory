import type {
  ChatMessageHandler,
  HandlerRegistryDependencies,
} from '@/backend/domains/session/chat/chat-message-handlers/types';
import { buildQueuedMessage } from '@/backend/domains/session/chat/chat-message-handlers/utils';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { MessageState, resolveSelectedModel } from '@/shared/acp-protocol';
import type { QueueMessageInput } from '@/shared/websocket';

export function createQueueMessageHandler(
  deps: HandlerRegistryDependencies
): ChatMessageHandler<QueueMessageInput> {
  return async ({ ws, sessionId, message }) => {
    const text = message.text?.trim();
    const hasContent = text || (message.attachments && message.attachments.length > 0);

    if (!hasContent) {
      ws.send(JSON.stringify({ type: 'error', message: 'Empty message' }));
      return;
    }

    if (!message.id) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing message id' }));
      return;
    }

    const messageId = message.id;

    const queuedMsg = buildQueuedMessage(messageId, message, text ?? '');
    const result = sessionDomainService.enqueue(sessionId, queuedMsg);

    if ('error' in result) {
      sessionDomainService.emitDelta(sessionId, {
        type: 'message_state_changed',
        id: messageId,
        newState: MessageState.REJECTED,
        errorMessage: result.error,
      });
      return;
    }

    sessionDomainService.emitDelta(sessionId, {
      type: 'message_state_changed',
      id: messageId,
      newState: MessageState.ACCEPTED,
      queuePosition: result.position,
      userMessage: {
        text: queuedMsg.text,
        timestamp: queuedMsg.timestamp,
        attachments: queuedMsg.attachments,
        settings: {
          ...queuedMsg.settings,
          selectedModel: resolveSelectedModel(queuedMsg.settings.selectedModel),
          reasoningEffort: queuedMsg.settings.reasoningEffort,
        },
      },
    });

    await deps.tryDispatchNextMessage(sessionId);
  };
}
