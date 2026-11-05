import { randomUUID } from 'node:crypto';
import type { SessionCommandError, SessionCommandOutcome } from '@/backend/services/session';
import { type MessageAttachment, MessageState, type WebSocketMessage } from '@/shared/acp-protocol';
import { DirectInputContentItemSchema } from '@/shared/websocket/direct-input-content.schema';

function recoverDirectInput(content: string | unknown[]) {
  const attachments: MessageAttachment[] = [];
  if (typeof content === 'string') {
    return { text: content };
  }
  const text: string[] = [];
  for (const rawItem of content) {
    const parsed = DirectInputContentItemSchema.safeParse(rawItem);
    if (!parsed.success) {
      continue;
    }
    const item = parsed.data;
    if (item.type === 'text') {
      text.push(item.text);
    } else if (item.type === 'image') {
      const { data, media_type: mediaType } = item.source;
      attachments.push({
        id: randomUUID(),
        name: `image.${mediaType.slice('image/'.length)}`,
        type: mediaType,
        contentType: 'image',
        size: Buffer.byteLength(data, 'base64'),
        data,
      });
    }
  }
  return { text: text.join('\n'), ...(attachments.length ? { attachments } : {}) };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; code?: unknown; data?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      return candidate.message;
    }
    if (typeof candidate.data !== 'undefined') {
      try {
        return JSON.stringify(candidate.data);
      } catch {
        // Fall through to generic object serialization
      }
    }
    if (typeof candidate.code === 'number' || typeof candidate.code === 'string') {
      return `ACP error (${String(candidate.code)})`;
    }
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatCommandError(error: SessionCommandError): string {
  switch (error.kind) {
    case 'no_session':
      return 'No session selected. Please create or select a session first.';
    case 'permission_not_pending':
      return 'No pending ACP permission request found for this request ID';
    case 'session_not_found':
      return 'Session not found';
    case 'workspace_archived':
      return 'Workspace is archived or archiving and cannot start sessions.';
    case 'no_active_session':
      return 'No active session. Use queue_message to queue messages.';
    case 'background_monitoring_required':
      return 'Disable PR updates to cancel background monitoring';
    case 'message_not_queued':
      return 'Message not found in queue';
    case 'queue_input_invalid':
      return error.reason;
    case 'user_input_failed':
      return 'Could not send message. Try again.';
    case 'set_config_option_failed':
      return `Failed to set config option: ${getErrorMessage(error.cause)}`;
    default: {
      const detail = error.cause instanceof Error ? error.cause.message : String(error.cause);
      switch (error.kind) {
        case 'steer_failed':
          return `Failed to steer message: ${detail}`;
        case 'start_failed':
          return `Failed to start agent: ${detail}`;
        case 'set_model_failed':
          return `Failed to set model: ${detail}`;
        case 'set_thinking_budget_failed':
          return `Failed to set thinking budget: ${detail}`;
        case 'permission_response_failed':
          return `Failed to respond to permission: ${detail}`;
      }
    }
  }
}

/** Build the same recoverable rejection for immediate and later provider failures. */
function buildUserInputRejection(
  error: Extract<SessionCommandError, { kind: 'user_input_failed' }>
): Extract<WebSocketMessage, { type: 'message_state_changed' }> {
  return {
    type: 'message_state_changed',
    id: randomUUID(),
    newState: MessageState.REJECTED,
    errorMessage: formatCommandError(error),
    userMessage: {
      ...recoverDirectInput(error.content),
      sessionId: error.sessionId,
      timestamp: new Date().toISOString(),
    },
  };
}

/** Format requester outcomes; configuration publication belongs to the serialized service. */
export function applySessionCommandOutcome(
  requester: { send(payload: string): void },
  outcome: SessionCommandOutcome | undefined
): void {
  if (!outcome) {
    return;
  }
  // A repeated removal or a dispatch race can leave the message already gone.
  const replies = outcome.replies.filter(
    (reply) => reply.type !== 'error' || reply.error.kind !== 'message_not_queued'
  );
  for (const reply of replies) {
    if (reply.type === 'error') {
      if (reply.error.kind === 'user_input_failed') {
        requester.send(JSON.stringify(buildUserInputRejection(reply.error)));
        continue;
      }
      requester.send(
        JSON.stringify({
          type: 'error',
          ...(reply.requestId !== undefined ? { requestId: reply.requestId } : {}),
          message: formatCommandError(reply.error),
        })
      );
    } else {
      try {
        requester.send(JSON.stringify(reply));
      } catch (cause) {
        requester.send(
          JSON.stringify({
            type: 'error',
            message: formatCommandError({ kind: 'set_model_failed', cause }),
          })
        );
      }
    }
  }
}
