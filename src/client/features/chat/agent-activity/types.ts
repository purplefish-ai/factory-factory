/**
 * Agent-specific type definitions.
 */

import type { ToolResultContentValue as _ToolResultContentValue } from '@/lib/chat-protocol';

// =============================================================================
// Agent-Specific Types
// =============================================================================

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
