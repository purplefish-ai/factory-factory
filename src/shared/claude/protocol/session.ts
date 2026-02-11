import type { ClaudeContentItem, ToolResultContentValue } from './content';
import type { MessageAttachment } from './queued';

/**
 * Session info from list_sessions.
 * claudeSessionId is the Claude CLI session ID (filename in ~/.claude/projects/).
 */
export interface SessionInfo {
  claudeSessionId: string;
  createdAt: string;
  modifiedAt: string;
  sizeBytes: number;
}

/**
 * Base fields for messages parsed from Claude session history.
 */
interface HistoryMessageBase {
  timestamp: string;
  uuid?: string;
  attachments?: MessageAttachment[];
}

export interface UserHistoryMessage extends HistoryMessageBase {
  type: 'user';
  content: string;
}

export interface AssistantHistoryMessage extends HistoryMessageBase {
  type: 'assistant';
  content: string;
}

export interface ThinkingHistoryMessage extends HistoryMessageBase {
  type: 'thinking';
  content: string;
}

export interface ToolUseHistoryMessage extends HistoryMessageBase {
  type: 'tool_use';
  content: string;
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
}

export interface ToolResultHistoryMessage extends HistoryMessageBase {
  type: 'tool_result';
  content: ToolResultContentValue;
  toolId?: string;
  isError?: boolean;
}

export interface UserToolResultHistoryMessage extends HistoryMessageBase {
  type: 'user_tool_result';
  content: ClaudeContentItem[];
}

/**
 * Message from session history.
 */
export type HistoryMessage =
  | UserHistoryMessage
  | AssistantHistoryMessage
  | ThinkingHistoryMessage
  | ToolUseHistoryMessage
  | ToolResultHistoryMessage
  | UserToolResultHistoryMessage;
