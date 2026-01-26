/**
 * Storybook fixture data extracted from a real Claude CLI session.
 *
 * This module exports session data for use in Storybook stories and tests.
 * The data is a curated selection of ~40-50 messages representing various
 * message types:
 *
 * - System messages (stop_hook_summary, compact_boundary)
 * - User messages (text and tool_result)
 * - Assistant messages (text, thinking, tool_use)
 * - Tool uses: Read, Write, Edit, Bash, Glob, Grep, Task, TodoWrite, etc.
 * - Tool results (success and error)
 *
 * Long content has been truncated to keep the fixture size manageable.
 */

import type { ChatMessage, ClaudeMessage } from '@/lib/claude-types';

import sessionData from './current-session.json';

export { sessionData };

// =============================================================================
// Session Data Conversion Types
// =============================================================================

interface SessionMessageContent {
  role?: string;
  content?: string | ContentItem[];
}

interface ContentItem {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface BaseSessionMessage {
  type: string;
  uuid: string;
  timestamp: string;
  subtype?: string;
  isMeta?: boolean;
  message?: SessionMessageContent;
}

// =============================================================================
// Session Data Conversion Helpers
// =============================================================================

/**
 * Checks if content starts with a system or local command prefix.
 */
function isSystemContent(text: string): boolean {
  return text.startsWith('<system_instruction>') || text.startsWith('<local-command');
}

/**
 * Creates a tool result ClaudeMessage.
 */
function createToolResultClaudeMessage(timestamp: string, toolResult: ContentItem): ClaudeMessage {
  return {
    type: 'stream_event',
    timestamp,
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_result',
        tool_use_id: toolResult.tool_use_id as string,
        content: toolResult.content as string,
        is_error: toolResult.is_error,
      },
    },
  };
}

/**
 * Creates a tool use ClaudeMessage.
 */
function createToolUseClaudeMessage(timestamp: string, toolUseItem: ContentItem): ClaudeMessage {
  return {
    type: 'stream_event',
    timestamp,
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: toolUseItem.id as string,
        name: toolUseItem.name as string,
        input: toolUseItem.input || {},
      },
    },
  };
}

/**
 * Creates a thinking ClaudeMessage.
 */
function createThinkingClaudeMessage(timestamp: string, thinkingItem: ContentItem): ClaudeMessage {
  return {
    type: 'stream_event',
    timestamp,
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'thinking',
        thinking: thinkingItem.thinking as string,
      },
    },
  };
}

/**
 * Creates a text assistant ClaudeMessage.
 */
function createTextClaudeMessage(timestamp: string, textItem: ContentItem): ClaudeMessage {
  return {
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: textItem.text as string }],
    },
  };
}

/**
 * Converts a user session message to ChatMessage.
 */
function convertUserMessage(msg: BaseSessionMessage): ChatMessage | null {
  const messageContent = msg.message;

  // Skip meta messages
  if (msg.isMeta) {
    return null;
  }

  // Handle string content
  if (typeof messageContent?.content === 'string') {
    if (isSystemContent(messageContent.content)) {
      return null;
    }
    return {
      id: msg.uuid,
      source: 'user',
      text: messageContent.content,
      timestamp: msg.timestamp,
    };
  }

  // Handle tool result arrays
  if (Array.isArray(messageContent?.content)) {
    const toolResult = messageContent.content.find(
      (item: ContentItem) => item.type === 'tool_result'
    );
    if (toolResult?.tool_use_id && toolResult.content !== undefined) {
      return {
        id: msg.uuid,
        source: 'claude',
        message: createToolResultClaudeMessage(msg.timestamp, toolResult),
        timestamp: msg.timestamp,
      };
    }
  }

  return null;
}

/**
 * Converts an assistant session message to ChatMessage.
 */
function convertAssistantMessage(msg: BaseSessionMessage): ChatMessage | null {
  const content = msg.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const textItem = content.find((item: ContentItem) => item.type === 'text');
  const thinkingItem = content.find((item: ContentItem) => item.type === 'thinking');
  const toolUseItem = content.find((item: ContentItem) => item.type === 'tool_use');

  // Priority: tool_use > thinking > text
  if (toolUseItem?.id && toolUseItem.name) {
    return {
      id: msg.uuid,
      source: 'claude',
      message: createToolUseClaudeMessage(msg.timestamp, toolUseItem),
      timestamp: msg.timestamp,
    };
  }

  if (thinkingItem?.thinking) {
    return {
      id: msg.uuid,
      source: 'claude',
      message: createThinkingClaudeMessage(msg.timestamp, thinkingItem),
      timestamp: msg.timestamp,
    };
  }

  if (textItem?.text) {
    return {
      id: msg.uuid,
      source: 'claude',
      message: createTextClaudeMessage(msg.timestamp, textItem),
      timestamp: msg.timestamp,
    };
  }

  return null;
}

/**
 * Converts a system session message to ChatMessage.
 */
function convertSystemMessage(msg: BaseSessionMessage): ChatMessage | null {
  if (msg.subtype !== 'compact_boundary') {
    return null;
  }

  const claudeMessage: ClaudeMessage = {
    type: 'system',
    timestamp: msg.timestamp,
    subtype: 'compact_boundary',
    status: 'Conversation compacted',
  };

  return {
    id: msg.uuid,
    source: 'claude',
    message: claudeMessage,
    timestamp: msg.timestamp,
  };
}

/**
 * Converts a session message from the fixture format to a ChatMessage.
 */
function convertSessionMessage(msg: BaseSessionMessage): ChatMessage | null {
  switch (msg.type) {
    case 'user':
      return convertUserMessage(msg);
    case 'assistant':
      return convertAssistantMessage(msg);
    case 'system':
      return convertSystemMessage(msg);
    default:
      return null;
  }
}

// =============================================================================
// Exported Session Data Converters
// =============================================================================

/**
 * Converts all session messages to ChatMessages, filtering out nulls.
 */
export function convertAllSessionMessages(): ChatMessage[] {
  return (sessionData as BaseSessionMessage[])
    .map(convertSessionMessage)
    .filter((msg): msg is ChatMessage => msg !== null);
}

/**
 * Gets messages containing thinking blocks.
 */
export function getThinkingMessages(): ChatMessage[] {
  return (sessionData as BaseSessionMessage[])
    .filter((msg) => {
      if (msg.type !== 'assistant') {
        return false;
      }
      const content = msg.message?.content;
      if (!Array.isArray(content)) {
        return false;
      }
      return content.some((item: ContentItem) => item.type === 'thinking');
    })
    .map(convertSessionMessage)
    .filter((msg): msg is ChatMessage => msg !== null);
}

/**
 * Gets tool use messages for a specific tool, converted to ChatMessage format.
 */
export function getToolUseMessagesConverted(toolName: string): ChatMessage[] {
  return (sessionData as BaseSessionMessage[])
    .filter((msg) => {
      if (msg.type !== 'assistant') {
        return false;
      }
      const content = msg.message?.content;
      if (!Array.isArray(content)) {
        return false;
      }
      return content.some(
        (item: ContentItem) => item.type === 'tool_use' && item.name === toolName
      );
    })
    .map(convertSessionMessage)
    .filter((msg): msg is ChatMessage => msg !== null);
}

/**
 * Gets tool result messages with errors.
 */
export function getErrorResultMessages(): ChatMessage[] {
  return (sessionData as BaseSessionMessage[])
    .filter((msg) => {
      if (msg.type !== 'user') {
        return false;
      }
      const content = msg.message?.content;
      if (!Array.isArray(content)) {
        return false;
      }
      return content.some(
        (item: ContentItem) => item.type === 'tool_result' && item.is_error === true
      );
    })
    .map(convertSessionMessage)
    .filter((msg): msg is ChatMessage => msg !== null);
}

/**
 * Type representing the session fixture data array.
 */
export type SessionFixture = typeof sessionData;

/**
 * Type representing a single message from the session fixture.
 */
export type SessionMessage = SessionFixture[number];

/**
 * Helper to filter messages by type for Storybook stories.
 */
export function filterMessagesByType<T extends SessionMessage['type']>(
  type: T
): Extract<SessionMessage, { type: T }>[] {
  return sessionData.filter(
    (msg): msg is Extract<SessionMessage, { type: T }> => msg.type === type
  );
}

/**
 * Helper to get messages containing a specific tool use.
 */
export function getToolUseMessages(toolName: string): SessionMessage[] {
  return sessionData.filter((msg) => {
    if (msg.type !== 'assistant' || !msg.message?.content) {
      return false;
    }
    const content = msg.message.content;
    if (!Array.isArray(content)) {
      return false;
    }
    return content.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'tool_use' &&
        'name' in item &&
        item.name === toolName
    );
  });
}

/**
 * Helper to get messages containing tool results (success or error).
 */
export function getToolResultMessages(isError?: boolean): SessionMessage[] {
  return sessionData.filter((msg) => {
    if (msg.type !== 'user' || !msg.message?.content) {
      return false;
    }
    const content = msg.message.content;
    if (!Array.isArray(content)) {
      return false;
    }
    return content.some((item) => {
      if (typeof item !== 'object' || item === null || !('type' in item)) {
        return false;
      }
      if (item.type !== 'tool_result') {
        return false;
      }
      if (isError === undefined) {
        return true;
      }
      return ('is_error' in item && item.is_error) === isError;
    });
  });
}
