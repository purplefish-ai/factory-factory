/**
 * Types for agent activity components
 * Extends chat types with agent-specific metadata
 */

import type { AgentType, CliProcessStatus, ExecutionState } from '@prisma-gen/client';
import type {
  ChatMessage,
  ClaudeMessage,
  HistoryMessage,
  MessageGroup,
  ToolInfo,
  WebSocketMessage,
} from '../chat/types';

// Re-export chat types for convenience
export type { ChatMessage, ClaudeMessage, HistoryMessage, MessageGroup, ToolInfo };

/** Agent metadata from database */
export interface AgentMetadata {
  id: string;
  type: AgentType;
  executionState: ExecutionState;
  desiredExecutionState: string;
  worktreePath: string | null;
  sessionId: string | null;
  tmuxSessionName: string | null;
  cliProcessId: string | null;
  cliProcessStatus: CliProcessStatus | null;
  isHealthy: boolean;
  minutesSinceHeartbeat: number;
  currentTask?: {
    id: string;
    title: string;
    state: string;
    branchName?: string | null;
    prUrl?: string | null;
  } | null;
  assignedTasks?: Array<{
    id: string;
    title: string;
    state: string;
  }>;
}

/** Extended WebSocket message for agent activity */
export interface AgentWebSocketMessage extends WebSocketMessage {
  agentId?: string;
  agentMetadata?: AgentMetadata;
  workingDir?: string;
}

/** Accumulated token usage stats */
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
}

/** Connection state for the WebSocket */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

/** Agent activity state returned by the hook */
export interface AgentActivityState {
  messages: ChatMessage[];
  connected: boolean;
  connectionState: ConnectionState;
  running: boolean;
  agentMetadata: AgentMetadata | null;
  tokenStats: TokenStats;
  claudeSessionId: string | null;
  error: string | null;
}

/** File reference for tool results */
export interface FileReference {
  path: string;
  displayPath: string;
  lineNumber?: number;
  lineCount?: number;
}

/** Extract file reference from tool input/result */
export function extractFileReference(
  toolName: string,
  input?: Record<string, unknown>,
  result?: string
): FileReference | null {
  // Handle Read tool
  if (toolName === 'Read' && input?.file_path) {
    const path = input.file_path as string;
    return {
      path,
      displayPath: path.split('/').slice(-2).join('/'),
      lineNumber: input.offset as number | undefined,
      lineCount: input.limit as number | undefined,
    };
  }

  // Handle Edit tool
  if (toolName === 'Edit' && input?.file_path) {
    const path = input.file_path as string;
    return {
      path,
      displayPath: path.split('/').slice(-2).join('/'),
    };
  }

  // Handle Write tool
  if (toolName === 'Write' && input?.file_path) {
    const path = input.file_path as string;
    return {
      path,
      displayPath: path.split('/').slice(-2).join('/'),
    };
  }

  // Handle Glob tool results
  if (toolName === 'Glob' && result) {
    const lines = result.split('\n').filter(Boolean);
    if (lines.length === 1) {
      return {
        path: lines[0],
        displayPath: lines[0].split('/').slice(-2).join('/'),
      };
    }
  }

  return null;
}
