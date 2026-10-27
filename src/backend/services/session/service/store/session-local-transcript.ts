import type { ChatMessage } from '@/shared/acp-protocol';

/** Local status cards must not block provider history hydration or take provider order slots. */
export function isLocalTranscriptMessage(message: ChatMessage): boolean {
  return (
    message.source === 'agent' &&
    (message.message?.type === 'session_lifecycle' ||
      (message.message?.type === 'pr_update' &&
        (message.message.prDeliveryState === 'failed' ||
          message.message.prDeliveryState === 'cancelled')))
  );
}
