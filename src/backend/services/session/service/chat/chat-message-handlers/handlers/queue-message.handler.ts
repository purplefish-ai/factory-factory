import { createLogger } from '@/backend/services/logger.service';
import { ChatIntentConflictError } from '@/backend/services/session/resources/chat-intent.accessor';
import { validateAttachment } from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import {
  buildAcceptedMessageStateChange,
  buildQueuedMessage,
} from '@/backend/services/session/service/chat/chat-message-handlers/utils';
import type { SessionChatIntentService } from '@/backend/services/session/service/chat/session-chat-intent.service';
import type {
  SessionCommandHandler,
  SessionCommandOutcome,
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
      'enqueue' | 'emitDelta' | 'rejectMessage' | 'chatIntent'
    >;
    chatIntent?: Pick<SessionChatIntentService, 'accept' | 'hasAccepted'>;
    tryDispatchNextMessage: (sessionId: string) => Promise<void>;
  }
): SessionCommandHandler<QueueMessageInput> {
  return async ({ sessionId }, message) => {
    const text = message.text?.trim();
    const validationError = validateQueueMessageInput(message, text);
    if (validationError) {
      if (message.id && (await deps.chatIntent?.hasAccepted(sessionId, message.id))) {
        return rejectAcceptanceError(
          deps.domain,
          sessionId,
          message.id,
          new ChatIntentConflictError()
        );
      }
      return rejectInvalidMessage(deps.domain, sessionId, message.id, validationError);
    }

    const isCurrent = deps.backgroundDelivery.captureResumeGuard(sessionId);
    const messageId = message.id;
    let queuedMsg = buildQueuedMessage(messageId, message, text ?? '');
    let result: { position: number } | { error: string };
    try {
      if (deps.chatIntent) {
        const accepted = await deps.chatIntent.accept(sessionId, queuedMsg, isCurrent);
        if (accepted.position === undefined) {
          return { replies: [] };
        }
        queuedMsg = accepted.message;
        result = { position: accepted.position };
      } else {
        result = deps.domain.enqueue(sessionId, queuedMsg);
      }
    } catch (error) {
      return rejectAcceptanceError(deps.domain, sessionId, messageId, error);
    }

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

function rejectInvalidMessage(
  domain: Pick<SessionExecutionCommandServices['domain'], 'rejectMessage'>,
  sessionId: string,
  id: string,
  reason: string
): SessionCommandOutcome {
  if (id) {
    domain.rejectMessage(sessionId, id, reason);
    return { replies: [] };
  }
  return { replies: [{ type: 'error', error: { kind: 'queue_input_invalid', reason } }] };
}

function rejectAcceptanceError(
  domain: Pick<SessionExecutionCommandServices['domain'], 'rejectMessage'>,
  sessionId: string,
  messageId: string,
  error: unknown
): SessionCommandOutcome {
  if (error instanceof ChatIntentConflictError) {
    return {
      replies: [{ type: 'error', error: { kind: 'queue_input_invalid', reason: error.message } }],
    };
  }
  domain.rejectMessage(
    sessionId,
    messageId,
    error instanceof Error ? error.message : 'Unable to durably accept message'
  );
  return { replies: [] };
}
