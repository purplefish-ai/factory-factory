import type { ChatMessage } from '@/shared/acp-protocol';

export function isPRUpdateOutcomeMessage(message: ChatMessage): boolean {
  return (
    message.source === 'agent' &&
    message.message?.type === 'pr_update' &&
    (message.message.prDeliveryState === 'failed' ||
      message.message.prDeliveryState === 'cancelled')
  );
}

/** Local status cards must not block provider history hydration or take provider order slots. */
export function isLocalTranscriptMessage(message: ChatMessage): boolean {
  return (
    (message.source === 'agent' &&
      ((message.message?.type === 'question_response' &&
        message.id.startsWith('question-response:')) ||
        message.message?.type === 'session_lifecycle' ||
        (message.message?.type === 'session_notice' &&
          message.id.startsWith('provider-notice:')))) ||
    isPRUpdateOutcomeMessage(message)
  );
}

/** Stop evidence and local PR outcomes belong to the app session after a rollover. */
export function survivesProviderIdentityRollover(message: ChatMessage): boolean {
  return (
    isLocalTranscriptMessage(message) &&
    message.message?.type !== 'session_notice' &&
    message.message?.type !== 'question_response'
  );
}
