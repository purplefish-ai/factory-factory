import { resolveAttachmentContentType } from '@/backend/domains/session/chat/chat-message-handlers/attachment-utils';
import { tryHandleAsInteractiveResponse } from '@/backend/domains/session/chat/chat-message-handlers/interactive-response';
import type {
  ChatMessageHandler,
  HandlerRegistryDependencies,
} from '@/backend/domains/session/chat/chat-message-handlers/types';
import { buildQueuedMessage } from '@/backend/domains/session/chat/chat-message-handlers/utils';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { MessageState, resolveSelectedModel } from '@/shared/claude';
import type { QueueMessageInput } from '@/shared/websocket';

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
    if (responseText && tryHandleAsInteractiveResponse(sessionId, messageId, responseText)) {
      return;
    }

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
