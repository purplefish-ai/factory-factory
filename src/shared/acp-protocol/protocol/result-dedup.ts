import { QUEUED_MESSAGE_ORDER_BASE } from './constants';
import type { TextContent } from './content';
import type { AgentMessage, ChatMessage } from './messages';

function extractTextForResultDedup(message: AgentMessage): string {
  if (message.type === 'assistant' && message.message) {
    if (typeof message.message.content === 'string') {
      return message.message.content.trim();
    }

    if (Array.isArray(message.message.content)) {
      return message.message.content
        .filter((item): item is TextContent => item.type === 'text')
        .map((item) => item.text)
        .join('')
        .trim();
    }
  }

  if (
    message.type === 'stream_event' &&
    message.event?.type === 'content_block_start' &&
    message.event.content_block.type === 'text'
  ) {
    return message.event.content_block.text.trim();
  }

  return '';
}

function extractResultTextFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractResultTextFromUnknown(item, depth + 1);
      if (extracted !== null) {
        return extracted;
      }
    }
    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = ['result', 'text', 'output_text', 'output', 'message', 'content'];
  for (const key of preferredKeys) {
    if (!(key in record)) {
      continue;
    }
    const extracted = extractResultTextFromUnknown(record[key], depth + 1);
    if (extracted !== null) {
      return extracted;
    }
  }

  return null;
}

/**
 * Checks whether an incoming result message duplicates the latest assistant text already present.
 */
export function shouldSuppressDuplicateResultMessage(
  transcript: ChatMessage[],
  agentMessage: AgentMessage
): boolean {
  if (agentMessage.type !== 'result') {
    return false;
  }

  const incomingText = extractResultTextFromUnknown(agentMessage.result);
  if (incomingText === null) {
    return false;
  }

  if (!incomingText) {
    return true;
  }

  const isCurrentTurnBoundary = (candidate: ChatMessage): boolean => {
    if (candidate.source !== 'user') {
      return false;
    }
    return candidate.order < QUEUED_MESSAGE_ORDER_BASE;
  };

  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const candidate = transcript[i];
    if (!candidate) {
      continue;
    }
    // Only dedupe against assistant content in the current turn.
    // Crossing a user message boundary can suppress legitimate repeated answers.
    if (isCurrentTurnBoundary(candidate)) {
      return false;
    }

    if (candidate.source !== 'agent' || !candidate.message || candidate.message.type === 'result') {
      continue;
    }

    const existingText = extractTextForResultDedup(candidate.message);
    if (!existingText) {
      continue;
    }

    return existingText === incomingText;
  }

  return false;
}
