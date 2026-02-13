/**
 * Agent-specific type definitions.
 */

import type { ToolResultContentValue as _ToolResultContentValue } from '@/lib/chat-protocol';

// Re-export commonly used chat protocol types for index.ts
export type { ChatMessage, ClaudeMessage } from '@/lib/chat-protocol';

// =============================================================================
// Agent-Specific Types
// =============================================================================

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
