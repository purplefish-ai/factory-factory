/**
 * Frontend-specific TypeScript type definitions for the Claude CLI streaming protocol.
 *
 * This file provides types for:
 * - WebSocket message envelopes for the chat/agent-activity WebSocket protocol
 * - UI-specific types like ChatMessage, MessageGroup, etc.
 * - Local copies of Claude CLI types (since backend types are server-only)
 *
 * This is the single source of truth for frontend Claude types.
 */

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
  total_cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
  error?: string;
  result?: unknown;
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
// Pending Interactive Request Types
// =============================================================================

// Import and re-export from shared module (used by both frontend and backend)
import type { PendingInteractiveRequest as PendingInteractiveRequestType } from '@/shared/pending-request-types';

export type { PendingInteractiveRequest } from '@/shared/pending-request-types';

// Alias for use within this file
type PendingInteractiveRequest = PendingInteractiveRequestType;

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
    | 'status'
    | 'starting'
    | 'started'
    | 'stopped'
    | 'process_exit'
    // Message streaming
    | 'claude_message'
    // Errors and metadata
    | 'error'
    | 'sessions'
    | 'agent_metadata'
    // Interactive requests
    | 'permission_request'
    | 'user_question'
    | 'permission_cancelled'
    // Queue error handling
    | 'message_rejected'
    | 'message_used_as_response'
    // Message state machine events (primary protocol)
    | 'message_state_changed'
    | 'messages_snapshot'
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
    | 'slash_commands';
  sessionId?: string;
  dbSessionId?: string;
  running?: boolean;
  message?: string;
  code?: number;
  data?: unknown;
  sessions?: SessionInfo[];
  agentMetadata?: AgentMetadata;
  // Permission request fields
  requestId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // Plan content for ExitPlanMode permission requests
  planContent?: string | null;
  // AskUserQuestion fields
  questions?: AskUserQuestion[];
  // Message fields
  text?: string;
  id?: string;
  /** Backend-assigned order for message_used_as_response events */
  order?: number;
  // Message state machine fields (primary protocol)
  /** New state for message_state_changed events */
  newState?: MessageState;
  /** Pre-built ChatMessages for messages_snapshot events (ready for frontend to use directly) */
  messages?: ChatMessage[];
  /** Session status for messages_snapshot events */
  sessionStatus?: SessionStatus;
  /** Pending interactive request for messages_snapshot events */
  pendingInteractiveRequest?: PendingInteractiveRequest | null;
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
  data: string; // base64 encoded
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
  /** Backend-assigned order for reliable sorting (monotonically increasing per session) */
  order: number;
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
 *
 * @example
 * ```typescript
 * function processMessage(msg: MessageWithState) {
 *   if (msg.type === 'user') {
 *     // TypeScript knows msg is UserMessageWithState here
 *     console.log(msg.text); // text is required
 *     console.log(msg.queuePosition); // queue position available
 *   } else {
 *     // TypeScript knows msg is ClaudeMessageWithState here
 *     console.log(msg.content); // content available
 *   }
 * }
 * ```
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
  order?: number;
}

/**
 * Message group type for rendering.
 */
export type MessageGroupType = 'user' | 'assistant' | 'tool_group';

/**
 * Grouped messages for rendering.
 */
export interface MessageGroup {
  type: MessageGroupType;
  messages: ChatMessage[];
  id: string;
}

// =============================================================================
// Token/Stats Types
// =============================================================================

/**
 * Token usage stats for display.
 */
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
}

// =============================================================================
// Connection State Types
// =============================================================================

/**
 * Connection state for WebSocket.
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

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
// Type Guards
// =============================================================================

/**
 * Type guard to check if a content item is TextContent.
 */
export function isTextContent(item: ClaudeContentItem): item is TextContent {
  return item.type === 'text';
}

/**
 * Type guard to check if a content item is ThinkingContent.
 */
export function isThinkingContent(item: ClaudeContentItem): item is ThinkingContent {
  return item.type === 'thinking';
}

/**
 * Type guard to check if a content item is ToolUseContent.
 */
export function isToolUseContent(item: ClaudeContentItem): item is ToolUseContent {
  return item.type === 'tool_use';
}

/**
 * Type guard to check if a content item is ToolResultContent.
 */
export function isToolResultContent(item: ClaudeContentItem): item is ToolResultContent {
  return item.type === 'tool_result';
}

/**
 * Type guard to check if a content item is ImageContent.
 */
export function isImageContent(item: ClaudeContentItem): item is ImageContent {
  return item.type === 'image' && 'source' in item;
}

/**
 * Type guard to check if a MessageWithState is a UserMessageWithState.
 * Use this for type-safe handling of user messages.
 *
 * @example
 * ```typescript
 * if (isUserMessage(msg)) {
 *   // msg is UserMessageWithState here
 *   console.log(msg.text); // text is required
 *   console.log(msg.state); // UserMessageState type
 * }
 * ```
 */
export function isUserMessage(msg: MessageWithState): msg is UserMessageWithState {
  return msg.type === 'user';
}

/**
 * Type guard to check if a MessageWithState is a ClaudeMessageWithState.
 * Use this for type-safe handling of Claude messages.
 *
 * @example
 * ```typescript
 * if (isClaudeMessage(msg)) {
 *   // msg is ClaudeMessageWithState here
 *   console.log(msg.contentBlocks); // contentBlocks available
 *   console.log(msg.state); // ClaudeMessageState type
 * }
 * ```
 */
export function isClaudeMessage(msg: MessageWithState): msg is ClaudeMessageWithState {
  return msg.type === 'claude';
}

/**
 * Type guard to check if a stream event is a ContentBlockStartEvent.
 */
export function isContentBlockStartEvent(
  event: ClaudeStreamEvent
): event is { type: 'content_block_start'; index: number; content_block: ClaudeContentItem } {
  return event.type === 'content_block_start';
}

/**
 * Type guard to check if a stream event is a ContentBlockDeltaEvent.
 */
export function isContentBlockDeltaEvent(
  event: ClaudeStreamEvent
): event is { type: 'content_block_delta'; index: number; delta: ContentBlockDelta } {
  return event.type === 'content_block_delta';
}

// =============================================================================
// WebSocket Message Type Guards
// =============================================================================

/**
 * Type guard to validate unknown data is a WebSocketMessage.
 * Used for type-safe parsing of incoming WebSocket data.
 */
export function isWebSocketMessage(data: unknown): data is WebSocketMessage {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as { type?: unknown };
  return typeof obj.type === 'string';
}

/**
 * Type guard for claude_message WebSocket messages.
 */
export function isWsClaudeMessage(
  msg: WebSocketMessage
): msg is WebSocketMessage & { type: 'claude_message'; data: ClaudeMessage } {
  return msg.type === 'claude_message' && 'data' in msg && msg.data != null;
}

/**
 * Type guard for ClaudeMessage with stream_event type.
 */
export function isStreamEventMessage(
  msg: ClaudeMessage
): msg is ClaudeMessage & { type: 'stream_event'; event: ClaudeStreamEvent } {
  return msg.type === 'stream_event' && msg.event != null;
}

/**
 * Type guard for tool_use start events within a stream event.
 * Internal helper for getToolUseIdFromEvent.
 */
function isToolUseStartEvent(
  event: ClaudeStreamEvent
): event is { type: 'content_block_start'; index: number; content_block: ToolUseContent } {
  return event.type === 'content_block_start' && event.content_block?.type === 'tool_use';
}

/**
 * Extracts tool_use ID from a stream event if it's a tool_use start event.
 * Returns null if not a tool_use start event.
 */
export function getToolUseIdFromEvent(event: ClaudeStreamEvent): string | null {
  if (!isToolUseStartEvent(event)) {
    return null;
  }
  return event.content_block.id;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Groups messages by type for rendering.
 * Consecutive assistant messages and tool calls are grouped together.
 */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  for (const message of messages) {
    const isToolMessage =
      message.message?.type === 'stream_event' &&
      message.message.event?.type === 'content_block_start' &&
      isToolUseContent(message.message.event.content_block);

    const messageType: MessageGroupType =
      message.source === 'user' ? 'user' : isToolMessage ? 'tool_group' : 'assistant';

    // Start a new group if:
    // - No current group
    // - Different message type
    // - User messages always get their own group
    if (!currentGroup || currentGroup.type !== messageType || messageType === 'user') {
      currentGroup = {
        type: messageType,
        messages: [],
        id: `group-${message.id}`,
      };
      groups.push(currentGroup);
    }

    currentGroup.messages.push(message);
  }

  return groups;
}

/**
 * Extracts text from a content block start event.
 */
function extractTextFromContentBlockStart(block: ClaudeContentItem): string {
  if (isTextContent(block)) {
    return block.text;
  }
  if (isThinkingContent(block)) {
    return block.thinking;
  }
  return '';
}

/**
 * Extracts text from a content block delta event.
 */
function extractTextFromContentBlockDelta(delta: ContentBlockDelta): string {
  if (delta.type === 'text_delta') {
    return delta.text;
  }
  if (delta.type === 'thinking_delta') {
    return delta.thinking;
  }
  return '';
}

/**
 * Extracts text from a stream event.
 */
function extractTextFromStreamEvent(event: ClaudeStreamEvent): string {
  if (event.type === 'content_block_start') {
    return extractTextFromContentBlockStart(event.content_block);
  }
  if (event.type === 'content_block_delta') {
    return extractTextFromContentBlockDelta(event.delta);
  }
  return '';
}

/**
 * Extracts text from a content item for mapping.
 */
function extractTextFromContentItem(item: ClaudeContentItem): string {
  if (isTextContent(item)) {
    return item.text;
  }
  if (isThinkingContent(item)) {
    return item.thinking;
  }
  return '';
}

/**
 * Extracts text from message content.
 */
function extractTextFromMessageContent(content: ClaudeContentItem[] | string): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(extractTextFromContentItem).filter(Boolean).join('\n');
  }
  return '';
}

/**
 * Extracts text content from a ClaudeMessage.
 */
export function extractTextFromMessage(msg: ClaudeMessage): string {
  // Handle stream events
  if (msg.type === 'stream_event' && msg.event) {
    return extractTextFromStreamEvent(msg.event);
  }

  // Handle assistant/user messages with message payload
  if (msg.message) {
    return extractTextFromMessageContent(msg.message.content);
  }

  // Handle error messages
  if (msg.type === 'error' && msg.error) {
    return msg.error;
  }

  // Handle result messages
  if (msg.type === 'result' && msg.result) {
    return typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result);
  }

  return '';
}

/**
 * Extracts tool information from a ClaudeMessage.
 * Returns null if the message is not a tool use message.
 */
export function extractToolInfo(
  msg: ClaudeMessage
): { name: string; id: string; input: Record<string, unknown> } | null {
  // Check stream events for tool use
  if (msg.type === 'stream_event' && msg.event) {
    if (msg.event.type === 'content_block_start') {
      const block = msg.event.content_block;
      if (isToolUseContent(block)) {
        return {
          name: block.name,
          id: block.id,
          input: block.input,
        };
      }
    }
    return null;
  }

  // Check message content for tool use
  if (msg.message && Array.isArray(msg.message.content)) {
    for (const item of msg.message.content) {
      if (isToolUseContent(item)) {
        return {
          name: item.name,
          id: item.id,
          input: item.input,
        };
      }
    }
  }

  return null;
}

/**
 * Checks if a ClaudeMessage contains a tool use.
 */
export function isToolUseMessage(msg: ClaudeMessage): boolean {
  return extractToolInfo(msg) !== null;
}

/**
 * Checks if a ClaudeMessage contains a tool result.
 */
export function isToolResultMessage(msg: ClaudeMessage): boolean {
  // Check stream events for tool result
  if (msg.type === 'stream_event' && msg.event) {
    if (msg.event.type === 'content_block_start') {
      return isToolResultContent(msg.event.content_block);
    }
    return false;
  }

  // Check message content for tool result
  if (msg.message && Array.isArray(msg.message.content)) {
    return msg.message.content.some((item) => isToolResultContent(item));
  }

  return false;
}

/**
 * Represents tool result information extracted from a message.
 */
export interface ToolResultInfo {
  toolUseId: string;
  content: ToolResultContentValue;
  isError: boolean;
}

/**
 * Converts a ToolResultContent block to ToolResultInfo.
 */
function toolResultContentToInfo(block: ToolResultContent): ToolResultInfo {
  return {
    toolUseId: block.tool_use_id,
    content: block.content,
    isError: block.is_error ?? false,
  };
}

/**
 * Extracts tool result info from a stream event.
 */
function extractToolResultFromStreamEvent(event: ClaudeStreamEvent): ToolResultInfo | null {
  if (event.type === 'content_block_start' && isToolResultContent(event.content_block)) {
    return toolResultContentToInfo(event.content_block);
  }
  return null;
}

/**
 * Extracts tool result info from message content.
 */
function extractToolResultFromContent(content: ClaudeContentItem[]): ToolResultInfo | null {
  const toolResult = content.find((item) => isToolResultContent(item));
  if (toolResult && isToolResultContent(toolResult)) {
    return toolResultContentToInfo(toolResult);
  }
  return null;
}

/**
 * Extracts tool result information from a ClaudeMessage.
 * Returns null if the message is not a tool result message.
 */
export function extractToolResultInfo(msg: ClaudeMessage): ToolResultInfo | null {
  // Check stream events for tool result
  if (msg.type === 'stream_event' && msg.event) {
    return extractToolResultFromStreamEvent(msg.event);
  }

  // Check message content for tool result
  if (msg.message && Array.isArray(msg.message.content)) {
    return extractToolResultFromContent(msg.message.content);
  }

  return null;
}

// =============================================================================
// Tool Call Grouping Types
// =============================================================================

/**
 * Represents a tool call paired with its result.
 */
export interface PairedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'success' | 'error';
  result?: {
    content: ToolResultContentValue;
    isError: boolean;
  };
}

/**
 * Represents a grouped sequence of adjacent tool calls.
 * Each tool_use is paired with its corresponding tool_result.
 */
export interface ToolSequence {
  type: 'tool_sequence';
  id: string;
  pairedCalls: PairedToolCall[];
}

/**
 * Union type for items in a grouped message list.
 */
export type GroupedMessageItem = ChatMessage | ToolSequence;

/**
 * Checks if a grouped item is a ToolSequence.
 */
export function isToolSequence(item: GroupedMessageItem): item is ToolSequence {
  return (item as ToolSequence).type === 'tool_sequence';
}

/**
 * Processes a sequence of tool messages and extracts paired tool calls.
 * Each tool_use is paired with its corresponding tool_result.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex but necessary nested conditions for message type checking
function extractPairedToolCalls(toolMessages: ChatMessage[]): PairedToolCall[] {
  const pairedCalls: PairedToolCall[] = [];
  const toolUseIdToIndex = new Map<string, number>(); // Maps tool_use_id to pairedCalls index

  // First pass: collect all tool_use messages
  for (const msg of toolMessages) {
    if (msg.message && isToolUseMessage(msg.message)) {
      const toolInfo = extractToolInfo(msg.message);
      if (toolInfo) {
        toolUseIdToIndex.set(toolInfo.id, pairedCalls.length);
        pairedCalls.push({
          id: toolInfo.id,
          name: toolInfo.name,
          input: toolInfo.input,
          status: 'pending',
        });
      }
    }
  }

  // Second pass: match tool_result messages to their tool_use
  for (const msg of toolMessages) {
    if (msg.message && isToolResultMessage(msg.message)) {
      const resultInfo = extractToolResultInfo(msg.message);
      if (resultInfo) {
        const callIndex = toolUseIdToIndex.get(resultInfo.toolUseId);
        if (callIndex !== undefined) {
          pairedCalls[callIndex].status = resultInfo.isError ? 'error' : 'success';
          pairedCalls[callIndex].result = {
            content: resultInfo.content,
            isError: resultInfo.isError,
          };
        }
      }
    }
  }

  return pairedCalls;
}

/**
 * Groups adjacent tool_use and tool_result messages together.
 * Returns a mixed array of regular messages and tool sequences.
 * Each tool_use is paired with its corresponding tool_result for unified rendering.
 */
export function groupAdjacentToolCalls(messages: ChatMessage[]): GroupedMessageItem[] {
  const result: GroupedMessageItem[] = [];
  let currentToolSequence: ChatMessage[] = [];

  const flushToolSequence = () => {
    if (currentToolSequence.length === 0) {
      return;
    }

    const pairedCalls = extractPairedToolCalls(currentToolSequence);

    // Always create a sequence, even for single tools (so they're paired with results)
    const sequence: ToolSequence = {
      type: 'tool_sequence',
      id: `tool-seq-${currentToolSequence[0].id}`,
      pairedCalls,
    };
    result.push(sequence);
    currentToolSequence = [];
  };

  for (const message of messages) {
    const isToolMessage =
      message.message &&
      (isToolUseMessage(message.message) || isToolResultMessage(message.message));

    if (isToolMessage) {
      currentToolSequence.push(message);
    } else {
      // Flush any pending tool sequence before adding a non-tool message
      flushToolSequence();
      result.push(message);
    }
  }

  // Flush any remaining tool sequence
  flushToolSequence();

  return result;
}

// =============================================================================
// Token Stats
// =============================================================================

/**
 * Creates an empty TokenStats object.
 */
export function createEmptyTokenStats(): TokenStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    turnCount: 0,
  };
}

/**
 * Updates token stats from a result message.
 */
export function updateTokenStatsFromResult(stats: TokenStats, msg: ClaudeMessage): TokenStats {
  if (msg.type !== 'result') {
    return stats;
  }

  return {
    inputTokens: stats.inputTokens + (msg.usage?.input_tokens ?? 0),
    outputTokens: stats.outputTokens + (msg.usage?.output_tokens ?? 0),
    totalCostUsd: msg.total_cost_usd ?? stats.totalCostUsd,
    totalDurationMs: stats.totalDurationMs + (msg.duration_ms ?? 0),
    turnCount: msg.num_turns ?? stats.turnCount,
  };
}
