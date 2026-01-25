/**
 * Message utility functions for extracting and transforming chat data
 */

import type { ChatMessage, ClaudeMessage, HistoryMessage, MessageGroup, ToolInfo } from './types';

// ============================================================================
// Tool Info Extraction
// ============================================================================

/** Extract tool_use info from a content item */
export function extractToolUse(item: Record<string, unknown>): ToolInfo {
  return {
    type: 'tool_use',
    name: item.name as string,
    id: item.id as string,
    input: item.input as Record<string, unknown>,
  };
}

/** Extract tool_result info from a content item */
export function extractToolResult(item: Record<string, unknown>): ToolInfo {
  const content = item.content ?? item.result;
  return {
    type: 'tool_result',
    id: (item.tool_use_id ?? item.id) as string,
    result: typeof content === 'string' ? content : JSON.stringify(content),
    isError: item.is_error as boolean,
  };
}

/** Extract tool info from nested content array (streaming format) */
export function extractFromContent(content: Record<string, unknown>[]): ToolInfo | null {
  for (const item of content) {
    if (item.type === 'tool_use') {
      return extractToolUse(item);
    }
    if (item.type === 'tool_result') {
      return extractToolResult(item);
    }
  }
  return null;
}

/**
 * Extract tool info from a Claude message
 * Handles both flat format (from history) and nested format (from streaming)
 */
export function extractToolInfo(msg: ClaudeMessage): ToolInfo | null {
  // Flat format (from history): {type: 'tool_use', tool: '...', input: {...}}
  if (msg.type === 'tool_use') {
    return extractToolUse({ ...msg, name: msg.tool, id: msg.id });
  }
  if (msg.type === 'tool_result') {
    return extractToolResult(msg as unknown as Record<string, unknown>);
  }

  // Nested format (from streaming): {type: 'assistant', message: {content: [{type: 'tool_use', ...}]}}
  const content = (msg.message as { content?: Record<string, unknown>[] })?.content;
  if (Array.isArray(content)) {
    return extractFromContent(content);
  }

  return null;
}

/** Check if a message contains tool content */
export function hasToolContent(msg: ClaudeMessage): boolean {
  return extractToolInfo(msg) !== null;
}

// ============================================================================
// Message Grouping
// ============================================================================

/** Group messages by type for rendering */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentToolGroup: ChatMessage[] = [];
  let currentAssistantGroup: ChatMessage[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length > 0) {
      groups.push({
        type: 'tool_group',
        messages: currentToolGroup,
        id: `tool-group-${currentToolGroup[0].id}`,
      });
      currentToolGroup = [];
    }
  };

  const flushAssistantGroup = () => {
    if (currentAssistantGroup.length > 0) {
      groups.push({
        type: 'assistant',
        messages: currentAssistantGroup,
        id: `assistant-group-${currentAssistantGroup[0].id}`,
      });
      currentAssistantGroup = [];
    }
  };

  for (const msg of messages) {
    // Check if this message contains tool calls (handles both flat and nested formats)
    const isToolMessage = msg.message && hasToolContent(msg.message);

    if (isToolMessage) {
      flushAssistantGroup();
      currentToolGroup.push(msg);
    } else if (msg.source === 'user') {
      // User message (not containing tool results) - flush both groups
      flushToolGroup();
      flushAssistantGroup();
      groups.push({ type: 'user', messages: [msg], id: msg.id });
    } else {
      // Assistant message (text, delta, result, system, error, etc.)
      flushToolGroup();
      currentAssistantGroup.push(msg);
    }
  }

  // Flush remaining groups
  flushToolGroup();
  flushAssistantGroup();

  return groups;
}

// ============================================================================
// History Message Conversion
// ============================================================================

/** Convert a history message to a chat message */
export function convertHistoryMessage(msg: HistoryMessage, idx: number): ChatMessage {
  const base = {
    id: `history-${idx}-${msg.uuid}`,
    source: (msg.type === 'user' ? 'user' : 'claude') as 'user' | 'claude',
  };

  switch (msg.type) {
    case 'user':
      return { ...base, text: msg.content };
    case 'assistant':
      return {
        ...base,
        message: {
          type: 'assistant',
          timestamp: msg.timestamp,
          message: { content: [{ text: msg.content }] },
        },
      };
    case 'tool_use':
      return {
        ...base,
        message: {
          type: 'tool_use',
          timestamp: msg.timestamp,
          tool: msg.toolName,
          id: msg.toolId,
          input: msg.toolInput,
        },
      };
    case 'tool_result':
      return {
        ...base,
        message: {
          type: 'tool_result',
          timestamp: msg.timestamp,
          tool_use_id: msg.toolId,
          result: msg.content,
          is_error: msg.isError,
        },
      };
    default:
      return base;
  }
}
