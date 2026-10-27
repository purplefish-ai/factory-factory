import { MessageState, type QueuedMessage } from '@/shared/acp-protocol';
import type { PRUpdateDeliveryState } from '@/shared/pr-monitoring';
import type { RecentMessageRejection, SessionStore } from './session-store.types';
import { upsertTranscriptMessage } from './session-transcript';

export function recordPRUpdateOutcome(
  store: SessionStore,
  message: QueuedMessage,
  deliveryState: Extract<PRUpdateDeliveryState, 'failed' | 'cancelled'>,
  error?: string
): boolean {
  const queued = store.queue.find((entry) => entry.id === message.id);
  if (queued && queued !== message) {
    return false;
  }
  const existing = store.transcript.find((entry) => entry.id === message.id);
  const order = existing?.order ?? store.nextOrder++;
  upsertTranscriptMessage(store, {
    id: message.id,
    source: 'agent',
    timestamp: message.timestamp,
    order,
    message: {
      type: 'pr_update',
      text:
        deliveryState === 'cancelled' && message.text === 'PR update queued for the next turn'
          ? 'PR update cancelled before dispatch'
          : message.text,
      prDeliveryState: deliveryState,
      ...(error ? { error } : {}),
    },
  });
  return true;
}

export function buildMessageFailure(
  sessionId: string,
  message: QueuedMessage,
  errorMessage: string
): Omit<RecentMessageRejection, 'rejectedAt' | 'expiresAt'> {
  return {
    id: message.id,
    errorMessage,
    state: MessageState.FAILED,
    userMessage: {
      text: message.text,
      timestamp: message.timestamp,
      attachments: message.attachments,
      voiceMode: message.voiceMode,
      sessionId,
    },
  };
}
