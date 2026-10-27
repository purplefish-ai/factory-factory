import { createLogger } from '@/backend/services/logger.service';
import { validateAttachment } from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import {
  buildAcceptedMessageStateChange,
  buildQueuedMessage,
} from '@/backend/services/session/service/chat/chat-message-handlers/utils';
import type {
  SessionCommandHandler,
  SessionExecutionCommandServices,
} from '@/backend/services/session/service/chat/session-command.types';
import { PR_EVENT_MESSAGE_ID_PREFIX } from '@/shared/pr-monitoring';
import type { QueueMessageInput } from '@/shared/websocket';
import { WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX } from '@/shared/workspace-notifications';

const logger = createLogger('chat-message-handlers');

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

  if (
    message.source !== undefined ||
    message.id.startsWith(PR_EVENT_MESSAGE_ID_PREFIX) ||
    message.id.startsWith(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX)
  ) {
    return 'Reserved message id';
  }

  return validateAttachments(message.attachments);
}

export function createQueueMessageHandler(
  deps: Pick<SessionExecutionCommandServices, 'backgroundDelivery'> & {
    domain: Pick<
      SessionExecutionCommandServices['domain'],
      'enqueue' | 'emitDelta' | 'rejectMessage'
    >;
    tryDispatchNextMessage: (sessionId: string) => Promise<void>;
  }
): SessionCommandHandler<QueueMessageInput> {
  return async ({ sessionId }, message) => {
    const text = message.text?.trim();
    const validationError = validateQueueMessageInput(message, text);
    if (validationError) {
      if (message.id) {
        deps.domain.rejectMessage(sessionId, message.id, validationError);
        return { replies: [] };
      }

      return {
        replies: [
          { type: 'error', error: { kind: 'queue_input_invalid', reason: validationError } },
        ],
      };
    }

    const isCurrent = deps.backgroundDelivery.captureResumeGuard(sessionId);
    const messageId = message.id;
    const queuedMsg = buildQueuedMessage(messageId, message, text ?? '');
    const result = deps.domain.enqueue(sessionId, queuedMsg);

    if ('error' in result) {
      deps.domain.rejectMessage(sessionId, messageId, result.error);
      return { replies: [] };
    }

    deps.domain.emitDelta(
      sessionId,
      buildAcceptedMessageStateChange(messageId, queuedMsg, result.position)
    );

    void deps.backgroundDelivery.userResume(sessionId, isCurrent).catch((error) => {
      logger.warn('Failed to resume PR delivery after queued human input', { sessionId, error });
    });
    await deps.tryDispatchNextMessage(sessionId);
    return { replies: [] };
  };
}
