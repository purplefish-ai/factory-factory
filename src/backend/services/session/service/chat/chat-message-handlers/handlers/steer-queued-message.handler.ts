import type { SessionCommandHandler } from '@/backend/services/session/service/chat/session-command.types';
import { QueuedMessageNotFoundError } from '@/backend/services/session/service/dispatch/session-steering-errors';
import type { ChatMessageInput } from '@/shared/websocket';

export function createSteerQueuedMessageHandler(deps: {
  steerQueuedMessage(sessionId: string, messageId: string): Promise<void>;
}): SessionCommandHandler<Extract<ChatMessageInput, { type: 'steer_queued_message' }>> {
  const pending = new Map<string, { messageId: string; operation: Promise<void> }>();
  const steer = async (sessionId: string, messageId: string): Promise<void> => {
    const existing = pending.get(sessionId);
    if (existing?.messageId === messageId) {
      await existing.operation;
    } else if (existing) {
      // Let the dispatch service report its existing busy error.
      await deps.steerQueuedMessage(sessionId, messageId);
    } else {
      const operation = deps.steerQueuedMessage(sessionId, messageId);
      const entry = { messageId, operation };
      pending.set(sessionId, entry);
      try {
        await operation;
      } finally {
        if (pending.get(sessionId) === entry) {
          pending.delete(sessionId);
        }
      }
    }
  };
  return async ({ sessionId }, { messageId, requestId }) => {
    try {
      await steer(sessionId, messageId);
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
