import type { QueuedMessage, SessionDeltaEvent } from '@/shared/acp-protocol';

type QueuePosition = { position: number } | { error: string };

/** Runtime projection capabilities supplied by the session domain. */
export interface ChatIntentDomain {
  enqueue(sessionId: string, message: QueuedMessage): QueuePosition;
  restoreAcceptedMessage(sessionId: string, message: QueuedMessage): QueuePosition;
  removeQueuedMessage(
    sessionId: string,
    messageId: string,
    options?: { expectedMessage?: QueuedMessage }
  ): boolean;
  getQueueLength(sessionId: string): number;
  getQueueSnapshot(sessionId: string): QueuedMessage[];
  emitDelta(sessionId: string, event: SessionDeltaEvent): void;
  failMessage(sessionId: string, message: QueuedMessage, reason: string): void;
  clearMessageRejection(sessionId: string, messageId: string): void;
}
