import type { QueueMessageInput } from '../../../schemas/websocket';
import { messageQueueService } from '../../message-queue.service';
import { messageStateService } from '../../message-state.service';
import { tryHandleAsInteractiveResponse } from '../interactive-response';
import type { ChatMessageHandler, HandlerRegistryDependencies } from '../types';
import { buildQueuedMessage, notifyMessageAccepted } from '../utils';

export function createQueueMessageHandler(deps: HandlerRegistryDependencies): ChatMessageHandler {
  return async ({ ws, sessionId, message }) => {
    const typedMessage = message as QueueMessageInput;
    const text = typedMessage.text?.trim();
    const hasContent = text || (typedMessage.attachments && typedMessage.attachments.length > 0);

    if (!hasContent) {
      ws.send(JSON.stringify({ type: 'error', message: 'Empty message' }));
      return;
    }

    if (!typedMessage.id) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing message id' }));
      return;
    }

    // Check if there's a pending interactive request - if so, treat this message as a response
    const messageId = typedMessage.id;
    if (text && tryHandleAsInteractiveResponse(ws, sessionId, messageId, text)) {
      return;
    }

    const queuedMsg = buildQueuedMessage(messageId, typedMessage, text ?? '');
    const result = messageQueueService.enqueue(sessionId, queuedMsg);

    if ('error' in result) {
      // Create rejected message in state service - emits message_state_changed event
      messageStateService.createRejectedMessage(sessionId, messageId, result.error, text);
      return;
    }

    notifyMessageAccepted(sessionId, queuedMsg);
    await deps.tryDispatchNextMessage(sessionId);
  };
}
