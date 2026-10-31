import type { ChatMessageInput } from '@/shared/websocket';
import type { SessionCommandHandler } from '../../session-command.types';

export function createSteerQueuedMessageHandler(deps: {
  steerQueuedMessage(sessionId: string, messageId: string): Promise<void>;
}): SessionCommandHandler<Extract<ChatMessageInput, { type: 'steer_queued_message' }>> {
  return async ({ sessionId }, { messageId }) => {
    try {
      await deps.steerQueuedMessage(sessionId, messageId);
      return { replies: [] };
    } catch (cause) {
      return { replies: [{ type: 'error', error: { kind: 'steer_failed', cause } }] };
    }
  };
}
