import type {
  AgentMessage,
  ChatMessage,
  PendingInteractiveRequest,
  ToolUseContent,
  UserQuestionRequest,
} from '@/lib/chat-protocol';
import {
  getToolUseIdFromEvent,
  isStreamEventMessage,
  shouldPersistAgentMessage,
  shouldSuppressDuplicateResultMessage,
  updateTokenStatsFromResult,
} from '@/lib/chat-protocol';
import { createDebugLogger } from '@/lib/debug';
import { isUserQuestionRequest } from '@/shared/pending-request-types';
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

function appendThinkingDelta(state: ChatState, index: number, deltaText: string): ChatState {
  if (!deltaText) {
    return state;
  }

  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const msg = state.messages[i];
    if (!msg) {
      continue;
    }
    if (msg.source !== 'agent' || !msg.message || !isStreamEventMessage(msg.message)) {
      continue;
    }

    const event = msg.message.event;
    if (
      event?.type !== 'content_block_start' ||
      event.content_block.type !== 'thinking' ||
      event.index !== index
    ) {
      continue;
    }

    const nextMessages = [...state.messages];
    nextMessages[i] = {
      ...msg,
      message: {
        ...msg.message,
        event: {
          ...event,
          content_block: {
            ...event.content_block,
            thinking: (event.content_block.thinking ?? '') + deltaText,
          },
        },
      },
    } as ChatMessage;

    return { ...state, messages: nextMessages };
  }

  return state;
}

function createClaudeMessage(message: AgentMessage, order: number): ChatMessage {
  return {
    id: generateMessageId(),
    source: 'agent',
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
    const midMessage = messages[mid];
    if (!midMessage) {
      throw new Error(`Missing message at index ${mid}`);
    }
    if (midMessage.order <= newOrder) {
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
 * Checks if a message is a tool_use message with the given ID.
 */
function isToolUseMessageWithId(msg: ChatMessage, toolUseId: string): boolean {
  if (msg.source !== 'agent' || !msg.message) {
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
function getToolUseIdFromMessage(claudeMsg: AgentMessage): string | null {
  if (!isStreamEventMessage(claudeMsg)) {
    return null;
  }
  return getToolUseIdFromEvent(claudeMsg.event);
}

/**
 * Update an existing Claude message in-place for a matching order.
 * Returns null when no existing message was found.
 */
function upsertClaudeMessageAtOrder(
  state: ChatState,
  claudeMsg: AgentMessage,
  order: number
): ChatState | null {
  const existingIndex = state.messages.findIndex(
    (msg) => msg.source === 'agent' && msg.order === order
  );
  if (existingIndex < 0) {
    return null;
  }

  const existingMsg = state.messages[existingIndex];
  if (!existingMsg) {
    return null;
  }
  const existingToolUseId = existingMsg.message
    ? getToolUseIdFromMessage(existingMsg.message)
    : null;
  const incomingToolUseId = getToolUseIdFromMessage(claudeMsg);

  const updatedMessages = [...state.messages];
  updatedMessages[existingIndex] = {
    ...existingMsg,
    message: claudeMsg,
    timestamp: claudeMsg.timestamp ?? existingMsg.timestamp,
  };

  if (existingToolUseId !== incomingToolUseId) {
    const nextToolUseIdToIndex = new Map(state.toolUseIdToIndex);
    if (existingToolUseId) {
      nextToolUseIdToIndex.delete(existingToolUseId);
    }
    if (incomingToolUseId) {
      nextToolUseIdToIndex.set(incomingToolUseId, existingIndex);
    }
    return {
      ...state,
      messages: updatedMessages,
      toolUseIdToIndex: nextToolUseIdToIndex,
    };
  }

  return {
    ...state,
    messages: updatedMessages,
  };
}

/**
 * Handle WS_AGENT_MESSAGE action - processes Claude messages and stores them.
 */
export function handleClaudeMessage(
  state: ChatState,
  claudeMsg: AgentMessage,
  order: number
): ChatState {
  let baseState: ChatState = state;

  // Runtime transitions are driven by session_runtime_updated events.
  // Result messages only update token stats here.
  if (claudeMsg.type === 'result') {
    baseState = {
      ...baseState,
      tokenStats: updateTokenStatsFromResult(baseState.tokenStats, claudeMsg),
    };

    if (shouldSuppressDuplicateResultMessage(baseState.messages, claudeMsg)) {
      return baseState;
    }
  }

  if (isStreamEventMessage(claudeMsg) && claudeMsg.event.type === 'message_start') {
    baseState = { ...baseState, latestThinking: null };
  }

  // Append thinking deltas to the most recent thinking content block
  if (
    isStreamEventMessage(claudeMsg) &&
    claudeMsg.event.type === 'content_block_delta' &&
    claudeMsg.event.delta.type === 'thinking_delta'
  ) {
    baseState = appendThinkingDelta(
      baseState,
      claudeMsg.event.index,
      claudeMsg.event.delta.thinking
    );
    baseState = {
      ...baseState,
      latestThinking: (baseState.latestThinking ?? '') + claudeMsg.event.delta.thinking,
    };
  }

  // Check if message should be stored
  if (!shouldPersistAgentMessage(claudeMsg)) {
    return baseState;
  }

  // If this Claude message order already exists, update in place instead of appending.
  // This prevents duplicate rendering when the same websocket event is delivered twice
  // (for example during reconnect/replay overlap).
  const upsertedState = upsertClaudeMessageAtOrder(baseState, claudeMsg, order);
  if (upsertedState) {
    return upsertedState;
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
    if (!cachedMsg) {
      messageIndex = undefined;
      needsIndexUpdate = true;
    } else if (!isToolUseMessageWithId(cachedMsg, toolUseId)) {
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
  if (!msg) {
    return currentState;
  }

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

  const updatedChatMessage = {
    ...msg,
    message: { ...claudeMsg, event: updatedEvent } as AgentMessage,
  } as ChatMessage;

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

  if (isUserQuestionRequest(req)) {
    const input = req.input as { questions?: unknown[] };
    return {
      type: 'question',
      request: {
        requestId: req.requestId,
        questions: (input.questions ?? []) as UserQuestionRequest['questions'],
        ...(Array.isArray(req.acpOptions) ? { acpOptions: req.acpOptions } : {}),
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
