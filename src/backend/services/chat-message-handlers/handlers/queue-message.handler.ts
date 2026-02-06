import type { QueueMessageInput } from '@/shared/websocket';
import { messageQueueService } from '../../message-queue.service';
import { messageStateService } from '../../message-state.service';
import { resolveAttachmentContentType } from '../attachment-utils';
import { tryHandleAsInteractiveResponse } from '../interactive-response';
import type { ChatMessageHandler, HandlerRegistryDependencies } from '../types';
import { buildQueuedMessage, notifyMessageAccepted } from '../utils';

/**
 * Extract text content from text attachments.
 * Used to provide content for interactive responses when user pastes large text
 * that becomes an attachment instead of inline text.
 */
function extractTextFromAttachments(
  attachments: QueueMessageInput['attachments']
): string | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  // Collect text from all text attachments
  const textParts: string[] = [];
  for (const attachment of attachments) {
    if (resolveAttachmentContentType(attachment) === 'text' && attachment.data) {
      textParts.push(attachment.data);
    }
  }

  // Return combined text if any text attachments found
  return textParts.length > 0 ? textParts.join('\n\n') : undefined;
}

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

    // Check if there's a pending interactive request - if so, treat this message as a response
    // Use inline text if available, otherwise extract text from text attachments
    // This handles the case where user pastes large text that becomes an attachment
    const messageId = message.id;
    const responseText = text || extractTextFromAttachments(message.attachments);
    if (responseText && tryHandleAsInteractiveResponse(ws, sessionId, messageId, responseText)) {
      return;
    }

    const queuedMsg = buildQueuedMessage(messageId, message, text ?? '');
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
