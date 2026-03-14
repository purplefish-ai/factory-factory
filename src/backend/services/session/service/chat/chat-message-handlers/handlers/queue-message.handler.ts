import { validateAttachment } from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import type {
  ChatMessageHandler,
  HandlerRegistryDependencies,
} from '@/backend/services/session/service/chat/chat-message-handlers/types';
import {
  buildAcceptedMessageStateChange,
  buildQueuedMessage,
} from '@/backend/services/session/service/chat/chat-message-handlers/utils';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { MessageState } from '@/shared/acp-protocol';
import type { QueueMessageInput } from '@/shared/websocket';

function validateAttachments(attachments: QueueMessageInput['attachments']): string | null {
  if (!attachments?.length) {
    return null;
  }

  try {
    for (const attachment of attachments) {
      validateAttachment(attachment);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid attachment';
  }
}

function validateQueueMessageInput(
  message: QueueMessageInput,
  text: string | undefined
): string | null {
  const hasContent = text || (message.attachments && message.attachments.length > 0);
  if (!hasContent) {
    return 'Empty message';
  }

  if (!message.id) {
    return 'Missing message id';
  }

  return validateAttachments(message.attachments);
}

function emitRejectedMessageState(
  sessionId: string,
  messageId: string,
  errorMessage: string
): void {
  sessionDomainService.emitDelta(sessionId, {
    type: 'message_state_changed',
    id: messageId,
    newState: MessageState.REJECTED,
    errorMessage,
  });
}

export function createQueueMessageHandler(
  deps: HandlerRegistryDependencies
): ChatMessageHandler<QueueMessageInput> {
  return async ({ ws, sessionId, message }) => {
    const text = message.text?.trim();
    const validationError = validateQueueMessageInput(message, text);
    if (validationError) {
      ws.send(JSON.stringify({ type: 'error', message: validationError }));
      return;
    }

    const messageId = message.id;
    const queuedMsg = buildQueuedMessage(messageId, message, text ?? '');
    const result = sessionDomainService.enqueue(sessionId, queuedMsg);

    if ('error' in result) {
      emitRejectedMessageState(sessionId, messageId, result.error);
      return;
    }

    sessionDomainService.emitDelta(
      sessionId,
      buildAcceptedMessageStateChange(messageId, queuedMsg, result.position)
    );

    await deps.tryDispatchNextMessage(sessionId);
  };
}
