import type { AgentContentItem } from './content';
import type { AgentMessage } from './messages';

type ContentTypeLike = { type: string };

export function isTextContent<T extends ContentTypeLike>(
  item: T
): item is Extract<T, { type: 'text' }> {
  return item.type === 'text';
}

export function isThinkingContent<T extends ContentTypeLike>(
  item: T
): item is Extract<T, { type: 'thinking' }> {
  return item.type === 'thinking';
}

export function isToolUseContent<T extends ContentTypeLike>(
  item: T
): item is Extract<T, { type: 'tool_use' }> {
  return item.type === 'tool_use';
}

export function isToolResultContent<T extends ContentTypeLike>(
  item: T
): item is Extract<T, { type: 'tool_result' }> {
  return item.type === 'tool_result';
}

export function isImageContent<T extends ContentTypeLike>(
  item: T
): item is Extract<T, { type: 'image' }> {
  if (item.type !== 'image') {
    return false;
  }

  const source = (item as { source?: unknown }).source;
  if (typeof source !== 'object' || source === null) {
    return false;
  }

  const imageSource = source as {
    type?: unknown;
    media_type?: unknown;
    data?: unknown;
  };

  return (
    imageSource.type === 'base64' &&
    typeof imageSource.media_type === 'string' &&
    typeof imageSource.data === 'string'
  );
}

/**
 * Narrow shape used to evaluate whether assistant content blocks should be rendered/stored.
 * Shared across backend forwarding and frontend reducer filtering to prevent drift.
 */
export interface AssistantRenderableContentLike {
  type?: string;
  text?: string;
  thinking?: string;
  source?: unknown;
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
  if (item.type === 'image') {
    const source = item.source;
    if (typeof source !== 'object' || source === null) {
      return false;
    }

    const imageSource = source as {
      type?: unknown;
      media_type?: unknown;
      data?: unknown;
    };

    return (
      imageSource.type === 'base64' &&
      typeof imageSource.media_type === 'string' &&
      typeof imageSource.data === 'string'
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
export function hasToolResultContent(content: AgentContentItem[] | string): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((item) => item.type === 'tool_result');
}

/**
 * Canonical predicate for whether an agent message should be persisted in transcript state.
 * Shared by backend session store and frontend reducer to prevent drift.
 */
export function shouldPersistAgentMessage(agentMsg: AgentMessage): boolean {
  if (agentMsg.type === 'user') {
    if (!agentMsg.message) {
      return false;
    }
    return hasToolResultContent(agentMsg.message.content);
  }

  if (agentMsg.type === 'assistant') {
    const content = agentMsg.message?.content;
    if (typeof content === 'string') {
      return content.length > 0;
    }
    return Array.isArray(content) && hasRenderableAssistantContent(content);
  }

  if (agentMsg.type === 'result') {
    return true;
  }

  if (agentMsg.type !== 'stream_event') {
    return true;
  }

  if (!agentMsg.event || agentMsg.event.type !== 'content_block_start') {
    return false;
  }

  const block = agentMsg.event.content_block as AssistantRenderableContentLike;
  if (block.type === 'text') {
    return false;
  }
  return isRenderableAssistantContentItem(block);
}
