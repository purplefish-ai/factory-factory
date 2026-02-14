import type { AgentContentItem, ToolResultContentValue } from './content';
import type { MessageAttachment } from './queued';

/**
 * Session info from ACP session listing.
 */
export interface SessionInfo {
  providerSessionId: string;
  createdAt: string;
  modifiedAt: string;
  sizeBytes: number;
}

/**
 * Base fields for messages parsed from agent session history.
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
  content: AgentContentItem[];
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
