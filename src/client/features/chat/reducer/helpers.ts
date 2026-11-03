import type {
  AgentMessage,
  ChatMessage,
  PendingInteractiveRequest,
  ToolUseContent,
} from '@/lib/chat-protocol';
import {
  compareTranscriptMessageOrder,
  DEFAULT_RENDERER_TRANSCRIPT_LIMIT,
  isStreamEventMessage,
  shouldPersistAgentMessage,
  shouldSuppressDuplicateResultMessage,
  trimTranscriptForRenderer,
  updateTokenStatsFromResult,
} from '@/lib/chat-protocol';
import { createDebugLogger, DEBUG_CHAT_WS } from '@/lib/debug';
import { getAskUserQuestions, isUserQuestionRequest } from '@/shared/pending-request-types';
import { getRendererTranscriptIds, resolveRendererTranscript } from './renderer-indexes';
import type { ChatAction, ChatState, PendingRequest } from './types';

// Shared chat debug flag, controlled by DEBUG_CHAT_WS env var.
const DEBUG_CHAT_REDUCER = DEBUG_CHAT_WS;
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

function createClaudeMessage(
  message: AgentMessage,
  order: number,
  messageId?: string
): ChatMessage {
  return {
    id: messageId ?? generateMessageId(),
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
  // Binary search to find insertion point based on order
  let low = 0;
  let high = messages.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const midMessage = messages[mid];
    if (!midMessage) {
      throw new Error(`Missing message at index ${mid}`);
    }
    if (compareTranscriptMessageOrder(midMessage, newMessage) <= 0) {
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

export function trimMessagesForRenderer(
  messages: ChatMessage[],
  limit = DEFAULT_RENDERER_TRANSCRIPT_LIMIT
): ChatMessage[] {
  return trimTranscriptForRenderer(messages, limit);
}

function filterMapByIds<Value>(
  map: Map<string, Value>,
  getRetainedIds: () => Set<string>
): Map<string, Value> {
  if (map.size === 0) {
    return map;
  }
  const retainedIds = getRetainedIds();
  const filtered = new Map<string, Value>();
  for (const [id, value] of map) {
    if (retainedIds.has(id)) {
      filtered.set(id, value);
    }
  }
  return filtered;
}

function filterSetByIds(set: Set<string>, getRetainedIds: () => Set<string>): Set<string> {
  if (set.size === 0) {
    return set;
  }
  const retainedIds = getRetainedIds();
  const filtered = new Set<string>();
  for (const id of set) {
    if (retainedIds.has(id)) {
      filtered.add(id);
    }
  }
  return filtered;
}

export function applyRendererMessages(state: ChatState, messages: ChatMessage[]): ChatState {
  const { retained: retainedMessages, indexes } = resolveRendererTranscript(
    state.messages,
    messages,
    state.rendererTranscriptLimit === undefined
      ? DEFAULT_RENDERER_TRANSCRIPT_LIMIT
      : state.rendererTranscriptLimit
  );
  const getRetainedIds = () => getRendererTranscriptIds(retainedMessages, indexes);
  const hasUnmappedLocalUserMessage =
    state.localUserMessageIds.size > 0 &&
    retainedMessages.some(
      (message) =>
        message.source === 'user' &&
        state.localUserMessageIds.has(message.id) &&
        !state.messageIdToUuid.has(message.id)
    );

  return {
    ...state,
    messages: retainedMessages,
    toolUseIdToIndex: indexes.toolUseIdToIndex,
    agentMessageOrderToIndex: indexes.agentMessageOrderToIndex,
    messageIdToUuid: filterMapByIds(state.messageIdToUuid, getRetainedIds),
    localUserMessageIds: filterSetByIds(state.localUserMessageIds, getRetainedIds),
    pendingUserMessageUuids:
      hasUnmappedLocalUserMessage || state.pendingMessages.size > 0
        ? state.pendingUserMessageUuids
        : [],
  };
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

/** ACP thought chunks lack message_start; visible text and tool starts also end a sequence. */
function startsThinkingBoundary(claudeMsg: AgentMessage): boolean {
  if (claudeMsg.type === 'assistant') {
    const content = claudeMsg.message?.content;
    return (
      typeof content === 'string' ||
      (Array.isArray(content) &&
        content.some((block) => block.type === 'text' || block.type === 'tool_use'))
    );
  }
  if (!isStreamEventMessage(claudeMsg)) {
    return false;
  }
  const event = claudeMsg.event;
  return (
    event.type === 'message_start' ||
    (event.type === 'content_block_start' &&
      ['thinking', 'tool_use'].includes(event.content_block.type))
  );
}

function hasExistingAgentMessageAtOrder(state: ChatState, order: number): boolean {
  return state.messages.some((msg) => msg.source === 'agent' && msg.order === order);
}

function resetThinkingAtOrder(
  state: ChatState,
  order: number,
  thinking: string | null = null
): ChatState {
  if (state.latestThinkingOrder !== null && order <= state.latestThinkingOrder) {
    return state;
  }
  return { ...state, latestThinking: thinking || null, latestThinkingOrder: order };
}

function resetThinkingAtBoundary(
  state: ChatState,
  message: AgentMessage,
  order: number
): ChatState {
  if (!startsThinkingBoundary(message) || hasExistingAgentMessageAtOrder(state, order)) {
    return state;
  }
  const event = isStreamEventMessage(message) ? message.event : undefined;
  const thinking =
    event?.type === 'content_block_start' && event.content_block.type === 'thinking'
      ? event.content_block.thinking
      : null;
  return resetThinkingAtOrder(state, order, thinking);
}

/**
 * Update an existing Claude message in-place for a matching order.
 * Returns null when no existing message was found.
 */
function upsertClaudeMessageAtOrder(
  state: ChatState,
  claudeMsg: AgentMessage,
  order: number,
  messageId?: string
): ChatState | null {
  const existingIndex = state.agentMessageOrderToIndex.get(order);
  if (existingIndex === undefined) {
    return null;
  }

  const existingMsg = state.messages[existingIndex];
  if (existingMsg?.source !== 'agent' || existingMsg.order !== order) {
    return null;
  }
  const updatedMessages = [...state.messages];
  updatedMessages[existingIndex] = {
    ...existingMsg,
    id: messageId ?? existingMsg.id,
    message: claudeMsg,
    timestamp: claudeMsg.timestamp ?? existingMsg.timestamp,
  };

  return applyRendererMessages(state, updatedMessages);
}

/**
 * Handle WS_AGENT_MESSAGE action - processes Claude messages and stores them.
 */
export function handleClaudeMessage(
  state: ChatState,
  claudeMsg: AgentMessage,
  order: number,
  messageId?: string
): ChatState {
  let baseState: ChatState = state;

  // Runtime transitions are driven by session_runtime_updated events.
  // Result messages only update token stats here.
  if (claudeMsg.type === 'result') {
    // Results may be suppressed or trimmed, so accounting cannot depend on rendered messages.
    if (!state.countedResultOrders.has(order)) {
      baseState = {
        ...baseState,
        tokenStats: updateTokenStatsFromResult(baseState.tokenStats, claudeMsg),
        countedResultOrders: new Set(state.countedResultOrders).add(order),
      };
    }

    if (shouldSuppressDuplicateResultMessage(baseState.messages, claudeMsg)) {
      return baseState;
    }
  }

  baseState = resetThinkingAtBoundary(baseState, claudeMsg, order);

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
      latestThinkingOrder: Math.max(baseState.latestThinkingOrder ?? order, order),
    };
  }

  // Check if message should be stored
  if (!shouldPersistAgentMessage(claudeMsg)) {
    return baseState;
  }

  // If this Claude message order already exists, update in place instead of appending.
  // This prevents duplicate rendering when the same websocket event is delivered twice
  // (for example during reconnect/replay overlap).
  const upsertedState = upsertClaudeMessageAtOrder(baseState, claudeMsg, order, messageId);
  if (upsertedState) {
    return upsertedState;
  }

  // Create and add the message using order-based insertion
  const chatMessage = createClaudeMessage(claudeMsg, order, messageId);
  const newMessages = insertMessageByOrder(baseState.messages, chatMessage);
  return applyRendererMessages(baseState, newMessages);
}

type AssistantTextDeltaPayload = Extract<
  ChatAction,
  { type: 'WS_ASSISTANT_TEXT_DELTA' }
>['payload'];

function getAssistantText(message: ChatMessage): string | null {
  const agentMessage = message.message;
  if (agentMessage?.type !== 'assistant') {
    return null;
  }
  const content = agentMessage.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const first = content[0];
  return first?.type === 'text' ? first.text : null;
}

function createAssistantTextMessage(payload: AssistantTextDeltaPayload): ChatMessage {
  return {
    id: payload.messageId,
    source: 'agent',
    message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: payload.text }] },
    },
    timestamp: new Date().toISOString(),
    order: payload.order,
  };
}

export function handleAssistantTextDelta(
  state: ChatState,
  payload: AssistantTextDeltaPayload
): ChatState {
  if (payload.text.length === 0 || payload.offset < 0) {
    return state;
  }

  const messageIndex = state.agentMessageOrderToIndex.get(payload.order);
  if (messageIndex === undefined) {
    if (payload.offset !== 0) {
      return state;
    }
    return applyRendererMessages(
      resetThinkingAtOrder(state, payload.order),
      insertMessageByOrder(state.messages, createAssistantTextMessage(payload))
    );
  }

  const existingMessage = state.messages[messageIndex];
  if (
    existingMessage?.source !== 'agent' ||
    existingMessage.order !== payload.order ||
    existingMessage.id !== payload.messageId
  ) {
    return state;
  }

  const currentText = getAssistantText(existingMessage);
  if (currentText === null || payload.offset > currentText.length) {
    return state;
  }
  const overlapLength = Math.min(payload.text.length, currentText.length - payload.offset);
  if (
    currentText.slice(payload.offset, payload.offset + overlapLength) !==
    payload.text.slice(0, overlapLength)
  ) {
    return state;
  }
  const unseenText = payload.text.slice(overlapLength);
  if (unseenText.length === 0) {
    return state;
  }

  const existingAgentMessage = existingMessage.message;
  const messagePayload = existingAgentMessage?.message;
  const content = messagePayload?.content;
  if (
    !(existingAgentMessage && messagePayload && Array.isArray(content)) ||
    content[0]?.type !== 'text'
  ) {
    return state;
  }
  const updatedContent = [...content];
  updatedContent[0] = { ...content[0], text: currentText + unseenText };
  const updatedMessages = [...state.messages];
  updatedMessages[messageIndex] = {
    ...existingMessage,
    message: {
      ...existingAgentMessage,
      message: {
        ...messagePayload,
        content: updatedContent,
      },
    },
  };
  return { ...state, messages: updatedMessages };
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
    return {
      type: 'question',
      request: {
        requestId: req.requestId,
        toolName: req.toolName,
        questions: getAskUserQuestions(req.input),
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
      ...(req.elicitation ? { elicitation: req.elicitation } : {}),
      timestamp: req.timestamp,
      planContent: req.planContent,
      ...(Array.isArray(req.acpOptions) ? { acpOptions: req.acpOptions } : {}),
    },
  };
}
