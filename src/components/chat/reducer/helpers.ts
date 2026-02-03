import type {
  ChatMessage,
  ClaudeMessage,
  PendingInteractiveRequest,
  ToolUseContent,
  UserQuestionRequest,
} from '@/lib/claude-types';
import {
  getToolUseIdFromEvent,
  isStreamEventMessage,
  updateTokenStatsFromResult,
} from '@/lib/claude-types';
import { createDebugLogger } from '@/lib/debug';
import type { ChatState, PendingRequest } from './types';

// Debug logger for chat reducer - set to true during development to see ignored state transitions
const DEBUG_CHAT_REDUCER = false;
const debug = createDebugLogger(DEBUG_CHAT_REDUCER);
export const debugLog = (...args: unknown[]): void => {
  debug.log(...args);
};

export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createClaudeMessage(message: ClaudeMessage, order: number): ChatMessage {
  return {
    id: generateMessageId(),
    source: 'claude',
    message,
    timestamp: new Date().toISOString(),
    order,
  };
}

/**
 * Inserts a message into the messages array at the correct position based on order.
 * Uses binary search for O(log n) performance. Messages are sorted by their
 * backend-assigned order (lowest first).
 */
export function insertMessageByOrder(
  messages: ChatMessage[],
  newMessage: ChatMessage
): ChatMessage[] {
  const newOrder = newMessage.order;

  // Binary search to find insertion point based on order
  let low = 0;
  let high = messages.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (messages[mid].order <= newOrder) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  // Insert at the found position
  const result = [...messages];
  result.splice(low, 0, newMessage);
  return result;
}

/**
 * Determines if a Claude message should be stored in state.
 * We filter out structural/delta events and only keep meaningful ones.
 */
function shouldStoreMessage(claudeMsg: ClaudeMessage): boolean {
  // User messages with tool_result content should be stored
  if (claudeMsg.type === 'user') {
    const content = claudeMsg.message?.content;
    if (Array.isArray(content)) {
      return content.some(
        (item) =>
          typeof item === 'object' && item !== null && 'type' in item && item.type === 'tool_result'
      );
    }
    return false;
  }

  // Result messages are always stored
  if (claudeMsg.type === 'result') {
    return true;
  }

  // For stream events, only store meaningful ones
  if (!isStreamEventMessage(claudeMsg)) {
    return true;
  }

  const event = claudeMsg.event;

  // Only store content_block_start for tool_use, tool_result, and thinking
  if (event.type === 'content_block_start') {
    const blockType = event.content_block.type;
    return blockType === 'tool_use' || blockType === 'tool_result' || blockType === 'thinking';
  }

  // Skip all other stream events
  return false;
}

/**
 * Checks if a message is a tool_use message with the given ID.
 */
function isToolUseMessageWithId(msg: ChatMessage, toolUseId: string): boolean {
  if (msg.source !== 'claude' || !msg.message) {
    return false;
  }
  const claudeMsg = msg.message;
  if (!isStreamEventMessage(claudeMsg)) {
    return false;
  }
  const event = claudeMsg.event;
  if (event.type !== 'content_block_start' || event.content_block.type !== 'tool_use') {
    return false;
  }
  const block = event.content_block as ToolUseContent;
  return block.id === toolUseId;
}

/**
 * Gets the tool use ID from a Claude message if it's a tool_use start event.
 */
function getToolUseIdFromMessage(claudeMsg: ClaudeMessage): string | null {
  if (!isStreamEventMessage(claudeMsg)) {
    return null;
  }
  return getToolUseIdFromEvent(claudeMsg.event);
}

/**
 * Handle WS_CLAUDE_MESSAGE action - processes Claude messages and stores them.
 */
export function handleClaudeMessage(
  state: ChatState,
  claudeMsg: ClaudeMessage,
  order: number
): ChatState {
  // Transition from starting to running when receiving a Claude message
  let baseState: ChatState =
    state.sessionStatus.phase === 'starting'
      ? { ...state, sessionStatus: { phase: 'running' } }
      : state;

  // Set to ready when we receive a result, and accumulate token stats
  if (claudeMsg.type === 'result') {
    baseState = {
      ...baseState,
      sessionStatus: { phase: 'ready' },
      tokenStats: updateTokenStatsFromResult(baseState.tokenStats, claudeMsg),
    };
  }

  // Check if message should be stored
  if (!shouldStoreMessage(claudeMsg)) {
    return baseState;
  }

  // Create and add the message using order-based insertion
  const chatMessage = createClaudeMessage(claudeMsg, order);
  const newMessages = insertMessageByOrder(baseState.messages, chatMessage);
  const newIndex = newMessages.indexOf(chatMessage);

  // Track tool_use message index for O(1) updates
  const toolUseId = getToolUseIdFromMessage(claudeMsg);
  if (toolUseId) {
    const newToolUseIdToIndex = new Map(baseState.toolUseIdToIndex);
    newToolUseIdToIndex.set(toolUseId, newIndex);
    return { ...baseState, messages: newMessages, toolUseIdToIndex: newToolUseIdToIndex };
  }

  return { ...baseState, messages: newMessages };
}

/**
 * Handle TOOL_INPUT_UPDATE action - updates tool input with O(1) lookup.
 */
export function handleToolInputUpdate(
  state: ChatState,
  toolUseId: string,
  input: Record<string, unknown>
): ChatState {
  // Try O(1) lookup first
  let messageIndex = state.toolUseIdToIndex.get(toolUseId);
  let currentState = state;
  let needsIndexUpdate = false;

  // If cached index exists, verify it points to the correct message
  // (index may be stale if messages were inserted in the middle of the array)
  if (messageIndex !== undefined) {
    const cachedMsg = state.messages[messageIndex];
    if (!isToolUseMessageWithId(cachedMsg, toolUseId)) {
      // Cached index is stale, need to do linear scan
      messageIndex = undefined;
      needsIndexUpdate = true;
    }
  }

  // Fallback to linear scan if not found or stale
  if (messageIndex === undefined) {
    messageIndex = state.messages.findIndex((msg) => isToolUseMessageWithId(msg, toolUseId));
    if (messageIndex === -1) {
      return state; // Tool use not found
    }
    needsIndexUpdate = true;
  }

  // Update index for future lookups if needed
  if (needsIndexUpdate) {
    const newToolUseIdToIndex = new Map(state.toolUseIdToIndex);
    newToolUseIdToIndex.set(toolUseId, messageIndex);
    currentState = { ...state, toolUseIdToIndex: newToolUseIdToIndex };
  }

  const msg = currentState.messages[messageIndex];

  // Update the message with new input
  const claudeMsg = msg.message;
  const event = claudeMsg?.event as
    | { type: 'content_block_start'; content_block: { type: string; input?: unknown } }
    | undefined;
  if (!event?.content_block) {
    return currentState;
  }

  const updatedEvent = {
    ...event,
    content_block: {
      ...event.content_block,
      input,
    },
  };

  const updatedChatMessage: ChatMessage = {
    ...msg,
    message: { ...claudeMsg, event: updatedEvent } as ClaudeMessage,
  };

  const newMessages = [...currentState.messages];
  newMessages[messageIndex] = updatedChatMessage;
  return { ...currentState, messages: newMessages };
}

/**
 * Convert a PendingInteractiveRequest from the backend to a PendingRequest for UI state.
 */
export function convertPendingRequest(
  req: PendingInteractiveRequest | null | undefined
): PendingRequest {
  if (!req) {
    return { type: 'none' };
  }

  if (req.toolName === 'AskUserQuestion') {
    const input = req.input as { questions?: unknown[] };
    return {
      type: 'question',
      request: {
        requestId: req.requestId,
        questions: (input.questions ?? []) as UserQuestionRequest['questions'],
        timestamp: req.timestamp,
      },
    };
  }

  return {
    type: 'permission',
    request: {
      requestId: req.requestId,
      toolName: req.toolName,
      toolInput: req.input,
      timestamp: req.timestamp,
      planContent: req.planContent,
    },
  };
}
