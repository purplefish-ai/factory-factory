import type { SessionCommandHandler } from '@/backend/services/session/service/chat/session-command.types';
import { QueuedMessageNotFoundError } from '@/backend/services/session/service/dispatch/session-steering-errors';
import type { ChatMessageInput } from '@/shared/websocket';

export function createSteerQueuedMessageHandler(deps: {
  steerQueuedMessage(sessionId: string, messageId: string): Promise<void>;
}): SessionCommandHandler<Extract<ChatMessageInput, { type: 'steer_queued_message' }>> {
  return async ({ sessionId }, { messageId, requestId }) => {
    try {
      await deps.steerQueuedMessage(sessionId, messageId);
      return { replies: requestId ? [{ type: 'steer_settled', requestId }] : [] };
    } catch (cause) {
      if (cause instanceof QueuedMessageNotFoundError) {
        return {
          replies: requestId
            ? [{ type: 'steer_settled', requestId }]
            : [{ type: 'error', error: { kind: 'message_not_queued' } }],
        };
      }
      return {
        replies: [
          {
            type: 'error',
            error: { kind: 'steer_failed', cause },
            ...(requestId ? { requestId } : {}),
          },
        ],
      };
    }
  };
}
