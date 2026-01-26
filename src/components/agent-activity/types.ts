/**
 * Agent-specific type definitions.
 *
 * Re-exports types from '@/lib/claude-types' and adds agent-specific types.
 */

import type { ToolResultContentValue as _ToolResultContentValue } from '@/lib/claude-types';

// Re-export all types from claude-types for convenience
export type {
  AgentAssignedTask,
  AgentCurrentTask,
  // Agent metadata types
  AgentMetadata,
  ChatMessage,
  ClaudeContentItem,
  // Message types
  ClaudeMessage,
  ClaudeMessagePayload,
  ClaudeStreamEvent,
  ClaudeUsage,
  ConnectionState,
  ContentBlockDelta,
  // Tool call grouping types
  GroupedMessageItem,
  HistoryMessage,
  ImageItem,
  MessageGroup,
  MessageGroupType,
  // Session types
  SessionInfo,
  // Content types
  TextContent,
  // Stream event types
  TextDelta,
  TextItem,
  ThinkingContent,
  ThinkingDelta,
  // Stats types
  TokenStats,
  ToolDefinition,
  ToolResultContent,
  ToolResultContentValue,
  ToolSequence,
  ToolUseContent,
  WebSocketMessage,
} from '@/lib/claude-types';

// Re-export helper functions
export {
  convertHistoryMessage,
  createEmptyTokenStats,
  extractTextFromMessage,
  extractToolInfo,
  extractToolResultInfo,
  groupAdjacentToolCalls,
  groupMessages,
  isContentBlockDeltaEvent,
  isContentBlockStartEvent,
  isTextContent,
  isThinkingContent,
  isToolResultContent,
  isToolResultMessage,
  isToolSequence,
  isToolUseContent,
  isToolUseMessage,
  updateTokenStatsFromResult,
} from '@/lib/claude-types';

// =============================================================================
// Agent-Specific Types
// =============================================================================

/**
 * Agent activity view state.
 */
export type AgentActivityState =
  | 'idle' // Not connected, no activity
  | 'connecting' // Attempting to connect
  | 'connected' // Connected but agent not running
  | 'running' // Agent is actively running
  | 'paused' // Agent is paused
  | 'error'; // Connection error

/**
 * Tool call group for rendering multiple tool calls together.
 */
export interface ToolCallGroup {
  id: string;
  toolCalls: ToolCallInfo[];
  startTimestamp: string;
  endTimestamp?: string;
  isComplete: boolean;
}

/**
 * Information about a single tool call.
 */
export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: {
    content: _ToolResultContentValue;
    isError: boolean;
  };
  timestamp: string;
}

/**
 * File reference extracted from tool calls.
 */
export interface FileReference {
  path: string;
  lineStart?: number;
  lineEnd?: number;
  toolName: string;
  toolCallId: string;
}
