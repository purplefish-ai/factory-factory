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
export type ClaudeContentItem = TextContent | ThinkingContent | ToolUseContent | ToolResultContent;

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
 * Union of content block delta types.
 */
export type ContentBlockDelta = TextDelta | ThinkingDelta;

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
}

// =============================================================================
// Session Types
// =============================================================================

/**
 * Session info from list_sessions.
 */
export interface SessionInfo {
  sessionId: string;
  createdAt: string;
  modifiedAt: string;
  sizeBytes: number;
}

/**
 * Message from session history.
 */
export interface HistoryMessage {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result';
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
  sessionId: string | null;
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
  type:
    | 'status'
    | 'started'
    | 'stopped'
    | 'process_exit'
    | 'claude_message'
    | 'error'
    | 'sessions'
    | 'session_loaded'
    | 'agent_metadata'
    | 'permission_request'
    | 'user_question';
  sessionId?: string;
  claudeSessionId?: string;
  running?: boolean;
  message?: string;
  code?: number;
  data?: unknown;
  sessions?: SessionInfo[];
  messages?: HistoryMessage[];
  agentMetadata?: AgentMetadata;
  // Permission request fields (Phase 9)
  requestId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // AskUserQuestion fields (Phase 11)
  questions?: AskUserQuestion[];
}

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
// Helper Functions
// =============================================================================

/**
 * Converts a history message to a chat message.
 */
export function convertHistoryMessage(msg: HistoryMessage): ChatMessage {
  const isUser = msg.type === 'user';

  return {
    id: msg.uuid || `history-${msg.timestamp}-${Math.random().toString(36).slice(2, 9)}`,
    source: isUser ? 'user' : 'claude',
    text: isUser ? msg.content : undefined,
    message: isUser
      ? undefined
      : {
          type: msg.type === 'tool_use' || msg.type === 'tool_result' ? 'assistant' : 'assistant',
          message: {
            role: 'assistant',
            content: msg.content,
          },
        },
    timestamp: msg.timestamp,
  };
}

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
