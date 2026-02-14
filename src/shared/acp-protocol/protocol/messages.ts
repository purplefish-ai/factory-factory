import type {
  AgentContentItem,
  AgentStreamEvent,
  AgentUsage,
  ModelUsage,
  ToolDefinition,
} from './content';

/**
 * Top-level message types received from the WebSocket.
 * These are the messages forwarded from the ACP runtime.
 */
export interface AgentMessage {
  type: 'system' | 'assistant' | 'user' | 'stream_event' | 'result' | 'error';
  timestamp?: string;
  session_id?: string;
  parent_tool_use_id?: string; // For subagent tracking (Phase 10)
  message?: {
    role: 'assistant' | 'user';
    content: AgentContentItem[] | string;
  };
  event?: AgentStreamEvent;
  // Result fields
  usage?: AgentUsage;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
  error?: string;
  result?: unknown;
  /** Model-specific usage stats including context window (keyed by model name) */
  model_usage?: Record<string, ModelUsage>;
  // System fields
  subtype?: string;
  tools?: ToolDefinition[];
  model?: string;
  // Additional system fields
  cwd?: string;
  apiKeySource?: string;
  status?: string;
}

const AGENT_MESSAGE_TYPE_MAP: Record<AgentMessage['type'], true> = {
  system: true,
  assistant: true,
  user: true,
  stream_event: true,
  result: true,
  error: true,
};

/**
 * Canonical list of valid payload types nested in agent_message events.
 */
export const AGENT_MESSAGE_TYPES = Object.keys(AGENT_MESSAGE_TYPE_MAP) as AgentMessage['type'][];

/**
 * UI chat message representation.
 */
export interface ChatMessage {
  id: string;
  source: 'user' | 'agent';
  text?: string; // For user messages
  message?: AgentMessage; // For agent messages
  timestamp: string;
  attachments?: import('./queued').MessageAttachment[]; // For user uploaded images/files
  /** Backend-assigned order for reliable sorting (monotonically increasing per session) */
  order: number;
}

/**
 * Session status - a discriminated union that makes invalid states unrepresentable.
 *
 * State transitions:
 *   idle → loading → starting → ready ↔ running → stopping → ready
 */
export type SessionStatus =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'starting' }
  | { phase: 'ready' }
  | { phase: 'running' }
  | { phase: 'stopping' };
