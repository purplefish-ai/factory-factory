/**
 * Shared protocol and type definitions for chat/WebSocket communication.
 *
 * This module is the source of truth for the client/server chat protocol,
 * shared constants, and message state machine types.
 */

import type { PendingInteractiveRequest } from '../pending-request-types';
import type { SessionRuntimeState } from '../session-runtime';

export type { PendingInteractiveRequest } from '../pending-request-types';

// =============================================================================
// Slash Command Types
// =============================================================================

/**
 * Information about a slash command from the Claude CLI.
 */
export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

// =============================================================================
// Model and Settings Types
// =============================================================================

/**
 * Information about an available model.
 */
export interface ModelInfo {
  value: string;
  displayName: string;
}

/**
 * Available models using Claude CLI aliases.
 * Opus is the default (when selectedModel is null).
 */
export const AVAILABLE_MODELS: ModelInfo[] = [
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
];

/**
 * Chat session settings that persist per-session.
 */
export interface ChatSettings {
  selectedModel: string;
  thinkingEnabled: boolean;
  planModeEnabled: boolean;
}

/**
 * Default chat settings for new sessions.
 */
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  selectedModel: 'opus',
  thinkingEnabled: false,
  planModeEnabled: false,
};

/**
 * Default thinking budget (tokens) for extended thinking mode.
 * Used with the SDK's set_max_thinking_tokens control request.
 */
export const DEFAULT_THINKING_BUDGET = 10_000;

/**
 * @deprecated Use DEFAULT_THINKING_BUDGET with setMaxThinkingTokens instead.
 * Suffix previously appended to user messages to enable extended thinking mode.
 * Kept for backwards compatibility during migration.
 */
export const THINKING_SUFFIX = ' ultrathink';

/**
 * Valid model values for server-side validation.
 */
export const VALID_MODEL_VALUES = AVAILABLE_MODELS.map((m) => m.value);

// =============================================================================
// Content Item Types (mirrors backend types for frontend use)
// =============================================================================

/**
 * Text content block in a message.
 */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Thinking/reasoning content block (extended thinking).
 */
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

/**
 * Tool use content block - Claude requesting to use a tool.
 */
export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Text item in a tool result content array.
 */
export interface TextItem {
  type: 'text';
  text: string;
}

/**
 * Image item in a tool result content array (base64 encoded).
 */
export interface ImageItem {
  type: 'image';
  source: {
    type: 'base64';
    data: string;
    media_type: string;
  };
}

/**
 * Image content block for user messages (base64 encoded).
 * Used when users upload images in chat.
 */
export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Value type for tool_result content field.
 */
export type ToolResultContentValue = string | Array<TextItem | ImageItem>;

/**
 * Tool result content block - result of a tool execution.
 */
export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: ToolResultContentValue;
  is_error?: boolean;
}

/**
 * Union of all content item types that can appear in a message.
 */
export type ClaudeContentItem =
  | TextContent
  | ThinkingContent
  | ToolUseContent
  | ToolResultContent
  | ImageContent;

// =============================================================================
// Stream Event Types
// =============================================================================

/**
 * Delta for text content blocks during streaming.
 */
export interface TextDelta {
  type: 'text_delta';
  text: string;
}

/**
 * Delta for thinking content blocks during streaming.
 */
export interface ThinkingDelta {
  type: 'thinking_delta';
  thinking: string;
}

/**
 * Delta for tool input JSON streaming.
 */
export interface InputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

/**
 * Union of content block delta types.
 */
export type ContentBlockDelta = TextDelta | ThinkingDelta | InputJsonDelta;

/**
 * Token usage statistics.
 */
export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
}

/**
 * Model-specific usage statistics from the SDK.
 * This matches the modelUsage/model_usage field in ResultMessage.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * Claude message within a stream event.
 */
export interface ClaudeMessagePayload {
  id?: string;
  type?: string;
  role: 'assistant' | 'user';
  model?: string;
  content: ClaudeContentItem[] | string;
  stop_reason?: string;
}

/**
 * Stream event types from the Claude CLI.
 */
export type ClaudeStreamEvent =
  | { type: 'message_start'; message: ClaudeMessagePayload }
  | { type: 'content_block_start'; index: number; content_block: ClaudeContentItem }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta?: { stop_reason?: string; stop_sequence?: string };
      usage?: ClaudeUsage;
    }
  | { type: 'message_stop' };

// =============================================================================
// Tool Definition Types
// =============================================================================

/**
 * Tool definition from system init message.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

/**
 * Plugin information from system init message.
 */
export interface PluginInfo {
  name: string;
  path: string;
}

/**
 * Session initialization data from system init message.
 * Stores information about the session's available tools, model, etc.
 */
export interface SessionInitData {
  tools: ToolDefinition[];
  model: string | null;
  cwd: string | null;
  apiKeySource: string | null;
  slashCommands: string[];
  plugins: PluginInfo[];
}

/**
 * Information about an active hook.
 */
export interface ActiveHookInfo {
  hookId: string;
  hookName: string;
  hookEvent: string;
  startedAt: string;
}

// =============================================================================
// Top-Level ClaudeMessage Type (from WebSocket)
// =============================================================================

/**
 * Top-level message types received from the WebSocket.
 * These are the messages forwarded from the Claude CLI process.
 */
export interface ClaudeMessage {
  type: 'system' | 'assistant' | 'user' | 'stream_event' | 'result' | 'error';
  timestamp?: string;
  session_id?: string;
  parent_tool_use_id?: string; // For subagent tracking (Phase 10)
  message?: {
    role: 'assistant' | 'user';
    content: ClaudeContentItem[] | string;
  };
  event?: ClaudeStreamEvent;
  // Result fields
  usage?: ClaudeUsage;
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

// =============================================================================
// AskUserQuestion Types (Phase 11)
// =============================================================================

/**
 * Option for AskUserQuestion.
 */
export interface AskUserQuestionOption {
  label: string;
  description: string;
}

/**
 * Question in AskUserQuestion input.
 */
export interface AskUserQuestion {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

/**
 * User question request for approval UI (Phase 11).
 */
export interface UserQuestionRequest {
  requestId: string;
  questions: AskUserQuestion[];
  timestamp: string;
}

// =============================================================================
// Permission Request Types (Phase 9)
// =============================================================================

/**
 * Permission request for approval UI (Phase 9).
 */
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: string;
  /** Plan content for ExitPlanMode requests (markdown) */
  planContent?: string | null;
}

// =============================================================================
// Session Types
// =============================================================================

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
 * Message from session history.
 */
export interface HistoryMessage {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'thinking';
  content: string;
  timestamp: string;
  uuid?: string;
  attachments?: MessageAttachment[];
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
}

// =============================================================================
// Agent Metadata Types
// =============================================================================

/**
 * Current task information for an agent.
 */
export interface AgentCurrentTask {
  id: string;
  title: string;
  state: string;
  branchName?: string | null;
  prUrl?: string | null;
}

/**
 * Assigned task information for an agent.
 */
export interface AgentAssignedTask {
  id: string;
  title: string;
  state: string;
}

/**
 * Agent metadata from WebSocket.
 */
export interface AgentMetadata {
  id: string;
  type: string;
  executionState: string;
  desiredExecutionState: string;
  worktreePath: string | null;
  /** Database session ID */
  dbSessionId: string | null;
  tmuxSessionName: string | null;
  cliProcessId: string | null;
  cliProcessStatus: string | null;
  isHealthy: boolean;
  minutesSinceHeartbeat: number;
  currentTask?: AgentCurrentTask | null;
  assignedTasks?: AgentAssignedTask[];
}

// =============================================================================
// WebSocket Message Types
// =============================================================================

/**
 * WebSocket message envelope types for the chat/agent-activity WebSocket protocol.
 */
export interface WebSocketMessage {
  type: // Session lifecycle events
    | 'session_snapshot'
    | 'session_delta'
    | 'status'
    | 'starting'
    | 'started'
    | 'stopped'
    | 'process_exit'
    // Unified runtime events
    | 'session_runtime_snapshot'
    | 'session_runtime_updated'
    // Message streaming
    | 'claude_message'
    // Errors and metadata
    | 'error'
    | 'sessions'
    | 'agent_metadata'
    // Interactive requests
    | 'permission_request'
    | 'user_question'
    | 'interactive_request'
    | 'permission_cancelled'
    // Queue error handling
    | 'message_rejected'
    | 'message_used_as_response'
    // Message state machine events (primary protocol)
    | 'message_state_changed'
    | 'session_replay_batch'
    // SDK message types
    | 'tool_progress'
    | 'tool_use_summary'
    | 'status_update'
    | 'task_notification'
    // System subtype events
    | 'system_init'
    | 'compact_boundary'
    | 'hook_started'
    | 'hook_response'
    // Context compaction events
    | 'compacting_start'
    | 'compacting_end'
    | 'queue'
    | 'workspace_notification_request'
    // Slash commands discovery
    | 'slash_commands'
    // User message UUID tracking (for rewind functionality)
    | 'user_message_uuid'
    // Rewind files response events
    | 'rewind_files_preview'
    | 'rewind_files_error';
  sessionId?: string;
  dbSessionId?: string;
  running?: boolean;
  processAlive?: boolean;
  message?: string;
  code?: number;
  data?: unknown;
  sessions?: SessionInfo[];
  agentMetadata?: AgentMetadata;
  // Permission request fields
  requestId?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  // Plan content for ExitPlanMode permission requests
  planContent?: string | null;
  // AskUserQuestion fields
  questions?: AskUserQuestion[];
  // Message fields
  text?: string;
  id?: string;
  /** Backend-assigned order for claude_message and message_used_as_response events */
  order?: number;
  // Message state machine fields (primary protocol)
  /** New state for message_state_changed events */
  newState?: MessageState;
  /** Pre-built ChatMessages for session_snapshot events (ready for frontend to use directly) */
  messages?: ChatMessage[];
  /** Unified runtime state for session_runtime_* events */
  sessionRuntime?: SessionRuntimeState;
  /** Pending interactive request for session_snapshot events */
  pendingInteractiveRequest?: PendingInteractiveRequest | null;
  /** Queued messages included in session_snapshot */
  queuedMessages?: QueuedMessage[];
  /** Client-generated ID for correlating load_session requests and responses */
  loadRequestId?: string;
  /** Batch of WebSocket events for atomic session replay during hydration */
  replayEvents?: WebSocketMessage[];
  /** Queue position for message_state_changed events */
  queuePosition?: number;
  /** Error message for REJECTED/FAILED states in message_state_changed events */
  errorMessage?: string;
  /** Full user message content for ACCEPTED state in message_state_changed events */
  userMessage?: {
    text: string;
    timestamp: string;
    attachments?: MessageAttachment[];
    settings?: ChatSettings;
    /** Backend-assigned order for reliable sorting */
    order?: number;
  };
  // Tool progress fields
  /** Tool use ID for tool_progress events */
  tool_use_id?: string;
  /** Tool name for tool_progress events */
  tool_name?: string;
  /** Parent tool use ID for nested tool calls */
  parent_tool_use_id?: string;
  /** Elapsed time in seconds for tool_progress events */
  elapsed_time_seconds?: number;
  // Tool use summary fields
  /** Summary text for tool_use_summary events */
  summary?: string;
  /** Preceding tool use IDs for tool_use_summary events */
  preceding_tool_use_ids?: string[];
  // Status update fields
  /** Permission mode from status updates */
  permissionMode?: string;
  /** Slash commands from CLI initialize response */
  slashCommands?: CommandInfo[];
  // User message UUID tracking fields (for rewind functionality)
  /** SDK-assigned UUID for user_message_uuid events */
  uuid?: string;
  /** User message ID for rewind_files_preview/error events */
  userMessageId?: string;
  /** Whether the rewind was a dry run */
  dryRun?: boolean;
  /** Affected files list for rewind_files_preview events */
  affectedFiles?: string[];
  /** Error message for rewind_files_error events */
  rewindError?: string;
  // Workspace notification request fields
  workspaceId?: string;
  workspaceName?: string;
  sessionCount?: number;
  finishedAt?: string;
}

// =============================================================================
// Queued Message Types
// =============================================================================

/**
 * Attachment data for uploaded files in chat.
 */
export interface MessageAttachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  data: string; // base64 for images, raw text for text attachments
  contentType?: 'image' | 'text'; // discriminator for rendering
}

/**
 * A message queued to be sent when the agent becomes idle.
 * This type is shared between frontend and backend.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: string;
  attachments?: MessageAttachment[];
  settings: {
    selectedModel: string | null;
    thinkingEnabled: boolean;
    planModeEnabled: boolean;
  };
}

// =============================================================================
// Message State Machine Types
// =============================================================================

/**
 * Message states for the unified message state machine.
 *
 * User message flow:
 *   PENDING → SENT → ACCEPTED → DISPATCHED → COMMITTED
 *                        ↘ REJECTED/FAILED/CANCELLED
 *
 * Claude message flow:
 *   STREAMING → COMPLETE
 *
 * Note: For type-safe state handling in discriminated unions, prefer using
 * `UserMessageState` or `ClaudeMessageState` type aliases. This enum provides
 * runtime values and is used throughout the codebase for state comparisons.
 */
export enum MessageState {
  // User message states
  PENDING = 'PENDING', // User typed, not yet sent to backend
  SENT = 'SENT', // Sent over WebSocket, awaiting ACK
  ACCEPTED = 'ACCEPTED', // Backend queued (has queuePosition)
  DISPATCHED = 'DISPATCHED', // Sent to Claude CLI
  COMMITTED = 'COMMITTED', // Response complete

  // Error states
  REJECTED = 'REJECTED', // Backend rejected (queue full, etc.)
  FAILED = 'FAILED', // Error during processing
  CANCELLED = 'CANCELLED', // User cancelled

  // Claude message states
  STREAMING = 'STREAMING', // Claude actively generating
  COMPLETE = 'COMPLETE', // Claude finished
}

// =============================================================================
// Type-Safe Message State Types
// =============================================================================

/**
 * Valid states for user messages.
 * User messages flow through: PENDING → SENT → ACCEPTED → DISPATCHED → COMMITTED
 * Or can terminate early with: REJECTED | FAILED | CANCELLED
 */
export type UserMessageState =
  | 'PENDING'
  | 'SENT'
  | 'ACCEPTED'
  | 'DISPATCHED'
  | 'COMMITTED'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Valid states for Claude messages.
 * Claude messages flow through: STREAMING → COMPLETE
 */
export type ClaudeMessageState = 'STREAMING' | 'COMPLETE';

/**
 * User message with state - has required user-specific fields.
 * The `type: 'user'` discriminant enables type narrowing.
 */
export interface UserMessageWithState {
  id: string;
  type: 'user';
  state: UserMessageState;
  timestamp: string;
  /** User message text - required for user messages */
  text: string;
  /** Optional file attachments */
  attachments?: MessageAttachment[];
  /** User message settings (model, thinking, plan mode) */
  settings?: QueuedMessage['settings'];
  /** Queue position when in ACCEPTED state */
  queuePosition?: number;
  /** Error message for REJECTED/FAILED states */
  errorMessage?: string;
  /** Backend-assigned order for reliable sorting (monotonically increasing per session).
   * Assigned when message transitions to DISPATCHED state (when sent to agent),
   * not when queued. Undefined for ACCEPTED (queued) messages. */
  order?: number;
}

/**
 * Claude message with state - has required Claude-specific fields.
 * The `type: 'claude'` discriminant enables type narrowing.
 */
export interface ClaudeMessageWithState {
  id: string;
  type: 'claude';
  state: ClaudeMessageState;
  timestamp: string;
  /** Pre-built ChatMessages for snapshot restoration - same format frontend uses */
  chatMessages: ChatMessage[];
  /** Backend-assigned order for reliable sorting (monotonically increasing per session) */
  order: number;
}

/**
 * Unified message type with state for the message state machine.
 * This is a discriminated union - use `msg.type` to narrow to the specific type.
 */
export type MessageWithState = UserMessageWithState | ClaudeMessageWithState;

// =============================================================================
// UI Chat Message Types
// =============================================================================

/**
 * UI chat message representation.
 */
export interface ChatMessage {
  id: string;
  source: 'user' | 'claude';
  text?: string; // For user messages
  message?: ClaudeMessage; // For claude messages
  timestamp: string;
  attachments?: MessageAttachment[]; // For user uploaded images/files
  /** Backend-assigned order for reliable sorting (monotonically increasing per session) */
  order: number;
}

// =============================================================================
// Session Status Types
// =============================================================================

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

// =============================================================================
// Type Guards Used On Client/Server
// =============================================================================

/**
 * Type guard to check if a MessageWithState is a UserMessageWithState.
 * Use this for type-safe handling of user messages.
 */
export function isUserMessage(msg: MessageWithState): msg is UserMessageWithState {
  return msg.type === 'user';
}

/**
 * Type guard to check if a MessageWithState is a ClaudeMessageWithState.
 * Use this for type-safe handling of Claude messages.
 */
export function isClaudeMessage(msg: MessageWithState): msg is ClaudeMessageWithState {
  return msg.type === 'claude';
}
