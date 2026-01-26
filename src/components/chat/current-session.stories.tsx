import type { Meta, StoryObj } from '@storybook/react';

import type { ChatMessage, ClaudeMessage } from '@/lib/claude-types';
import { sessionData } from '@/lib/fixtures';

import { MessageList } from './message-list';

// =============================================================================
// Type Definitions for Session Data
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
// Conversion Helpers
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
function createToolResultMessage(timestamp: string, toolResult: ContentItem): ClaudeMessage {
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
function createToolUseMessage(timestamp: string, toolUseItem: ContentItem): ClaudeMessage {
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
function createThinkingMessage(timestamp: string, thinkingItem: ContentItem): ClaudeMessage {
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
function createTextMessage(timestamp: string, textItem: ContentItem): ClaudeMessage {
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
        message: createToolResultMessage(msg.timestamp, toolResult),
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
      message: createToolUseMessage(msg.timestamp, toolUseItem),
      timestamp: msg.timestamp,
    };
  }

  if (thinkingItem?.thinking) {
    return {
      id: msg.uuid,
      source: 'claude',
      message: createThinkingMessage(msg.timestamp, thinkingItem),
      timestamp: msg.timestamp,
    };
  }

  if (textItem?.text) {
    return {
      id: msg.uuid,
      source: 'claude',
      message: createTextMessage(msg.timestamp, textItem),
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

// =============================================================================
// Session Data Conversion
// =============================================================================

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

/**
 * Converts all session messages to ChatMessages, filtering out nulls.
 */
function convertAllSessionMessages(): ChatMessage[] {
  return (sessionData as BaseSessionMessage[])
    .map(convertSessionMessage)
    .filter((msg): msg is ChatMessage => msg !== null);
}

/**
 * Gets messages containing thinking blocks.
 */
function getThinkingMessages(): ChatMessage[] {
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
 * Gets tool use messages for a specific tool.
 */
function getToolUseMessagesConverted(toolName: string): ChatMessage[] {
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
function getErrorResultMessages(): ChatMessage[] {
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

// =============================================================================
// Story Setup
// =============================================================================

const meta = {
  title: 'Chat/CurrentSession',
  component: MessageList,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="h-[600px] w-full max-w-4xl mx-auto border rounded-lg overflow-hidden bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MessageList>;

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// Stories Using Real Session Data
// =============================================================================

/**
 * Full conversation flow using real messages from an actual Claude CLI session.
 * This demonstrates the natural flow of a coding session including user prompts,
 * assistant responses, tool usage, and results.
 */
export const RealSessionConversation: Story = {
  name: 'Real Session Conversation',
  args: {
    messages: convertAllSessionMessages().slice(0, 20),
  },
};

/**
 * Full session with all messages (may be truncated for performance).
 * Shows the complete session data extracted from the fixture.
 */
export const FullSession: Story = {
  name: 'Full Session (All Messages)',
  args: {
    messages: convertAllSessionMessages(),
  },
};

/**
 * Filtered view showing only Read tool usage messages.
 * Demonstrates how the UI displays file reading operations.
 */
export const ReadToolCalls: Story = {
  name: 'Read Tool Calls',
  args: {
    messages: getToolUseMessagesConverted('Read'),
  },
};

/**
 * Filtered view showing only Bash command tool usage.
 * Demonstrates command execution tool rendering.
 */
export const BashToolCalls: Story = {
  name: 'Bash Tool Calls',
  args: {
    messages: getToolUseMessagesConverted('Bash'),
  },
};

/**
 * Filtered view showing only Edit tool usage.
 * Demonstrates file editing operations.
 */
export const EditToolCalls: Story = {
  name: 'Edit Tool Calls',
  args: {
    messages: getToolUseMessagesConverted('Edit'),
  },
};

/**
 * Filtered view showing only Glob and Grep search tool usage.
 * Demonstrates file search operations.
 */
export const SearchToolCalls: Story = {
  name: 'Search Tool Calls (Glob/Grep)',
  args: {
    messages: [...getToolUseMessagesConverted('Glob'), ...getToolUseMessagesConverted('Grep')],
  },
};

/**
 * Messages that include extended thinking/reasoning content.
 * Shows Claude's internal thought process before responding.
 */
export const RealThinkingBlocks: Story = {
  name: 'Real Thinking Blocks',
  args: {
    messages: getThinkingMessages(),
  },
};

/**
 * Messages showing error results from tool executions.
 * Demonstrates error handling and display in the UI.
 */
export const RealErrors: Story = {
  name: 'Real Errors',
  args: {
    messages: getErrorResultMessages(),
  },
};

/**
 * Mix of different tool types showing a typical development workflow.
 * Includes file reads, edits, and bash commands.
 */
export const MixedToolWorkflow: Story = {
  name: 'Mixed Tool Workflow',
  args: {
    messages: [
      ...getToolUseMessagesConverted('Read').slice(0, 2),
      ...getToolUseMessagesConverted('Edit').slice(0, 2),
      ...getToolUseMessagesConverted('Bash').slice(0, 2),
    ],
  },
};

/**
 * Task tool calls showing sub-agent creation.
 * Demonstrates how the UI renders complex nested operations.
 */
export const TaskToolCalls: Story = {
  name: 'Task Tool Calls (Sub-agents)',
  args: {
    messages: getToolUseMessagesConverted('Task'),
  },
};
