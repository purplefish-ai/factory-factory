import type { ChatMessage } from '@/lib/chat-protocol';

type MessageSourceOnly = Pick<ChatMessage, 'source'>;

export function hasUserMessageWithoutAgentMessage(messages: readonly MessageSourceOnly[]): boolean {
  let hasUserMessage = false;

  for (const message of messages) {
    if (message.source === 'agent') {
      return false;
    }
    if (message.source === 'user') {
      hasUserMessage = true;
    }
  }

  return hasUserMessage;
}
