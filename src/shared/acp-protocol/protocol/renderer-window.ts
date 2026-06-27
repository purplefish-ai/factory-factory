import { DEFAULT_RENDERER_TRANSCRIPT_LIMIT } from './constants';
import type { AgentContentItem } from './content';
import type { AgentMessage, ChatMessage } from './messages';

function hasContentType(
  content: NonNullable<AgentMessage['message']>['content'],
  type: AgentContentItem['type']
): boolean {
  return Array.isArray(content) && content.some((item) => item.type === type);
}

function isToolResultMessage(message: AgentMessage): boolean {
  if (message.type === 'stream_event') {
    return (
      message.event?.type === 'content_block_start' &&
      message.event.content_block.type === 'tool_result'
    );
  }

  return message.message ? hasContentType(message.message.content, 'tool_result') : false;
}

function isStreamFragment(message: AgentMessage): boolean {
  return message.type === 'stream_event' && message.event?.type !== 'content_block_start';
}

function isSafeRendererWindowStart(message: ChatMessage): boolean {
  if (message.source === 'user') {
    return true;
  }

  if (!message.message) {
    return false;
  }

  return !(isToolResultMessage(message.message) || isStreamFragment(message.message));
}

export function trimTranscriptForRenderer(
  messages: ChatMessage[],
  limit = DEFAULT_RENDERER_TRANSCRIPT_LIMIT
): ChatMessage[] {
  const sortedMessages = [...messages].sort((a, b) => a.order - b.order);
  if (sortedMessages.length <= limit) {
    return sortedMessages;
  }

  const windowStart = Math.max(0, sortedMessages.length - limit);
  const safeStart = sortedMessages.findIndex(
    (message, index) => index >= windowStart && isSafeRendererWindowStart(message)
  );

  if (safeStart === -1) {
    return sortedMessages.slice(windowStart);
  }

  return sortedMessages.slice(safeStart);
}
