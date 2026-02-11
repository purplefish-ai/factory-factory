import type { ClaudeContentItem } from './content';
import type { ClaudeMessage } from './messages';

/**
 * Narrow shape used to evaluate whether assistant content blocks should be rendered/stored.
 * Shared across backend forwarding and frontend reducer filtering to prevent drift.
 */
export interface AssistantRenderableContentLike {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

/**
 * True when a single assistant content block is renderable in chat UI.
 */
export function isRenderableAssistantContentItem(item: AssistantRenderableContentLike): boolean {
  if (item.type === 'text') {
    return typeof item.text === 'string';
  }
  if (item.type === 'thinking') {
    return typeof item.thinking === 'string';
  }
  if (item.type === 'tool_use') {
    return (
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      (item.input === undefined || (typeof item.input === 'object' && item.input !== null))
    );
  }
  if (item.type === 'tool_result') {
    return (
      typeof item.tool_use_id === 'string' &&
      (typeof item.content === 'string' || Array.isArray(item.content))
    );
  }
  return false;
}

/**
 * True when assistant content includes at least one renderable block.
 */
export function hasRenderableAssistantContent(content: AssistantRenderableContentLike[]): boolean {
  return content.some(isRenderableAssistantContentItem);
}

/**
 * True when user message content contains a tool_result block.
 */
export function hasToolResultContent(content: ClaudeContentItem[] | string): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((item) => item.type === 'tool_result');
}

/**
 * Canonical predicate for whether a Claude message should be persisted in transcript state.
 * Shared by backend session store and frontend reducer to prevent drift.
 */
export function shouldPersistClaudeMessage(claudeMsg: ClaudeMessage): boolean {
  if (claudeMsg.type === 'user') {
    if (!claudeMsg.message) {
      return false;
    }
    return hasToolResultContent(claudeMsg.message.content);
  }

  if (claudeMsg.type === 'assistant') {
    const content = claudeMsg.message?.content;
    return Array.isArray(content) && hasRenderableAssistantContent(content);
  }

  if (claudeMsg.type === 'result') {
    return true;
  }

  if (claudeMsg.type !== 'stream_event') {
    return true;
  }

  if (!claudeMsg.event || claudeMsg.event.type !== 'content_block_start') {
    return false;
  }

  const block = claudeMsg.event.content_block as AssistantRenderableContentLike;
  if (block.type === 'text') {
    return false;
  }
  return isRenderableAssistantContentItem(block);
}
