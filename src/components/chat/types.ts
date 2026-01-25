/**
 * Types for the chat components
 */

/** Base message from Claude streaming */
export interface ClaudeMessage {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

/** WebSocket message envelope */
export interface WebSocketMessage {
  type: string;
  data?: unknown;
  sessionId?: string;
  claudeSessionId?: string;
  running?: boolean;
  message?: string;
  code?: number;
  sessions?: string[];
  messages?: HistoryMessage[];
}

/** Message from session history */
export interface HistoryMessage {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  timestamp: string;
  uuid: string;
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
}

/** Extracted tool info (normalized from different formats) */
export interface ToolInfo {
  type: 'tool_use' | 'tool_result';
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

/** Internal chat message representation */
export interface ChatMessage {
  id: string;
  source: 'user' | 'claude';
  message?: ClaudeMessage;
  text?: string;
}

/** Grouped messages for rendering */
export interface MessageGroup {
  type: 'user' | 'assistant' | 'tool_group';
  messages: ChatMessage[];
  id: string;
}
