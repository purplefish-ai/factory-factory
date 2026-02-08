/**
 * Frontend helper utilities and UI-specific types for the Claude chat protocol.
 *
 * Core protocol types/constants are defined in src/shared/claude/protocol.ts
 * and re-exported here for convenience.
 */

export * from '@/shared/claude';

import type {
  ChatMessage,
  ClaudeContentItem,
  ClaudeMessage,
  ClaudeStreamEvent,
  ContentBlockDelta,
  ImageContent,
  ModelUsage,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolResultContentValue,
  ToolUseContent,
  WebSocketMessage,
} from '@/shared/claude';
import {
  CLAUDE_MESSAGE_TYPES,
  SESSION_DELTA_EXCLUDED_MESSAGE_TYPES,
  WEBSOCKET_MESSAGE_TYPES,
} from '@/shared/claude';

// =============================================================================
// UI Chat Message Group Types
// =============================================================================

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
 * Type guard to check if a content item is ImageContent.
 */
export function isImageContent(item: ClaudeContentItem): item is ImageContent {
  return item.type === 'image' && 'source' in item;
}

const wsMessageTypes = new Set<string>(WEBSOCKET_MESSAGE_TYPES);
const sessionDeltaExcludedMessageTypes = new Set<string>(SESSION_DELTA_EXCLUDED_MESSAGE_TYPES);
const claudeMessageTypes = new Set<string>(CLAUDE_MESSAGE_TYPES);

/**
 * Type guard to validate unknown data is a WebSocketMessage.
 * Used for type-safe parsing of incoming WebSocket data.
 */
export function isWebSocketMessage(data: unknown): data is WebSocketMessage {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as { type?: unknown; data?: unknown };
  if (typeof obj.type !== 'string' || !wsMessageTypes.has(obj.type)) {
    return false;
  }

  // session_delta must wrap another websocket event object.
  if (obj.type === 'session_delta') {
    if (typeof obj.data !== 'object' || obj.data === null) {
      return false;
    }
    const nested = obj.data as { type?: unknown };
    return (
      typeof nested.type === 'string' &&
      wsMessageTypes.has(nested.type) &&
      !sessionDeltaExcludedMessageTypes.has(nested.type)
    );
  }

  // claude_message must include a minimally shaped Claude payload to avoid runtime crashes.
  if (obj.type === 'claude_message') {
    if (typeof obj.data !== 'object' || obj.data === null) {
      return false;
    }
    const nested = obj.data as { type?: unknown };
    return typeof nested.type === 'string' && claudeMessageTypes.has(nested.type);
  }

  return true;
}

/**
 * Type guard for claude_message WebSocket messages.
 */
export function isWsClaudeMessage(
  msg: WebSocketMessage
): msg is Extract<WebSocketMessage, { type: 'claude_message' }> {
  return msg.type === 'claude_message' && typeof msg.data === 'object' && msg.data !== null;
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
 * Returns null if it's not a tool_use start event.
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
 * Tries to create a PairedToolCall from a ChatMessage.
 * Returns null if the message is not a tool_use message.
 */
function tryCreatePairedToolCall(msg: ChatMessage): PairedToolCall | null {
  if (!(msg.message && isToolUseMessage(msg.message))) {
    return null;
  }
  const toolInfo = extractToolInfo(msg.message);
  if (!toolInfo) {
    return null;
  }
  return {
    id: toolInfo.id,
    name: toolInfo.name,
    input: toolInfo.input,
    status: 'pending',
  };
}

/**
 * Updates a PairedToolCall with result info if the message contains a matching tool result.
 */
function applyToolResultToCall(
  msg: ChatMessage,
  pairedCalls: PairedToolCall[],
  toolUseIdToIndex: Map<string, number>
): void {
  if (!(msg.message && isToolResultMessage(msg.message))) {
    return;
  }
  const resultInfo = extractToolResultInfo(msg.message);
  if (!resultInfo) {
    return;
  }
  const callIndex = toolUseIdToIndex.get(resultInfo.toolUseId);
  if (callIndex === undefined) {
    return;
  }
  // biome-ignore lint/style/noNonNullAssertion: callIndex verified via Map lookup above
  pairedCalls[callIndex]!.status = resultInfo.isError ? 'error' : 'success';
  // biome-ignore lint/style/noNonNullAssertion: callIndex verified via Map lookup above
  pairedCalls[callIndex]!.result = {
    content: resultInfo.content,
    isError: resultInfo.isError,
  };
}

/**
 * Processes a sequence of tool messages and extracts paired tool calls.
 * Each tool_use is paired with its corresponding tool_result.
 */
function extractPairedToolCalls(toolMessages: ChatMessage[]): PairedToolCall[] {
  const pairedCalls: PairedToolCall[] = [];
  const toolUseIdToIndex = new Map<string, number>();

  // First pass: collect all tool_use messages
  for (const msg of toolMessages) {
    const pairedCall = tryCreatePairedToolCall(msg);
    if (pairedCall) {
      toolUseIdToIndex.set(pairedCall.id, pairedCalls.length);
      pairedCalls.push(pairedCall);
    }
  }

  // Second pass: match tool_result messages to their tool_use
  for (const msg of toolMessages) {
    applyToolResultToCall(msg, pairedCalls, toolUseIdToIndex);
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
      // biome-ignore lint/style/noNonNullAssertion: length checked above via early return
      id: `tool-seq-${currentToolSequence[0]!.id}`,
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
// Token/Stats Types
// =============================================================================

/**
 * Token usage stats for display.
 * Extended to include cache stats, context window, and API timing.
 */
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  totalDurationApiMs: number;
  turnCount: number;
  webSearchRequests: number;
  /** Context window size from the latest result (null if not yet received) */
  contextWindow: number | null;
  /** Max output tokens from the latest result (null if not yet received) */
  maxOutputTokens: number | null;
  /** Service tier from the latest usage (null if not yet received) */
  serviceTier: string | null;
}

/**
 * Threshold for warning when approaching context window limit.
 * At 80% usage, show yellow warning.
 */
export const CONTEXT_WARNING_THRESHOLD = 0.8;

/**
 * Threshold for critical context window usage.
 * At 95% usage, show red critical warning.
 */
export const CONTEXT_CRITICAL_THRESHOLD = 0.95;

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
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalDurationApiMs: 0,
    turnCount: 0,
    webSearchRequests: 0,
    contextWindow: null,
    maxOutputTokens: null,
    serviceTier: null,
  };
}

/**
 * Extracts model usage from the first model entry (typically there's only one).
 * Returns null if no model usage data is available.
 */
function extractFirstModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined
): ModelUsage | null {
  if (!modelUsage) {
    return null;
  }
  const models = Object.values(modelUsage);
  return models.length > 0 ? (models[0] ?? null) : null;
}

/**
 * Updates token stats from a result message.
 * Accumulates tokens, duration, and cost while taking the latest context window info.
 */
export function updateTokenStatsFromResult(stats: TokenStats, msg: ClaudeMessage): TokenStats {
  if (msg.type !== 'result') {
    return stats;
  }

  const modelUsage = extractFirstModelUsage(msg.model_usage);

  return {
    // Accumulate token counts
    inputTokens: stats.inputTokens + (msg.usage?.input_tokens ?? 0),
    outputTokens: stats.outputTokens + (msg.usage?.output_tokens ?? 0),
    cacheReadInputTokens: stats.cacheReadInputTokens + (msg.usage?.cache_read_input_tokens ?? 0),
    cacheCreationInputTokens:
      stats.cacheCreationInputTokens + (msg.usage?.cache_creation_input_tokens ?? 0),
    // Accumulate durations
    totalDurationMs: stats.totalDurationMs + (msg.duration_ms ?? 0),
    totalDurationApiMs: stats.totalDurationApiMs + (msg.duration_api_ms ?? 0),
    // Take latest cost (SDK provides cumulative cost)
    totalCostUsd: msg.total_cost_usd ?? stats.totalCostUsd,
    // Take latest turn count
    turnCount: msg.num_turns ?? stats.turnCount,
    // Accumulate web search requests from model usage
    webSearchRequests: stats.webSearchRequests + (modelUsage?.webSearchRequests ?? 0),
    // Take latest context window info
    contextWindow: modelUsage?.contextWindow ?? stats.contextWindow,
    maxOutputTokens: modelUsage?.maxOutputTokens ?? stats.maxOutputTokens,
    // Take latest service tier
    serviceTier: msg.usage?.service_tier ?? stats.serviceTier,
  };
}
