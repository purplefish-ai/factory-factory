/**
 * Chat state reducer for managing chat UI state.
 *
 * This reducer handles all state transitions for the chat interface:
 * - WebSocket message handling
 * - Session management (loading, switching)
 * - Permission and question requests
 * - Tool input streaming updates
 *
 * The state is designed to be used with useReducer for predictable updates.
 */

import type {
  ChatMessage,
  ChatSettings,
  ClaudeMessage,
  MessageAttachment,
  PendingInteractiveRequest,
  PermissionRequest,
  QueuedMessage,
  SessionInfo,
  SessionStatus as SharedSessionStatus,
  ToolUseContent,
  UserQuestionRequest,
  WebSocketMessage,
} from '@/lib/claude-types';
import {
  DEFAULT_CHAT_SETTINGS,
  getToolUseIdFromEvent,
  isStreamEventMessage,
  isWsClaudeMessage,
  MessageState,
} from '@/lib/claude-types';
import { createDebugLogger } from '@/lib/debug';

// Debug logger for chat reducer - set to true during development to see ignored state transitions
const DEBUG_CHAT_REDUCER = false;
const debug = createDebugLogger(DEBUG_CHAT_REDUCER);

// =============================================================================
// State Types
// =============================================================================

/** Information about a rejected message for recovery */
export interface RejectedMessageInfo {
  text: string;
  attachments?: MessageAttachment[];
  error: string;
}

/** Content stored for a pending message (for recovery on rejection) */
export interface PendingMessageContent {
  text: string;
  attachments?: MessageAttachment[];
}

/**
 * Pending interactive request - a discriminated union that makes it impossible
 * to have both a permission request and question request simultaneously.
 * Replaces separate pendingPermission and pendingQuestion nullable fields.
 */
export type PendingRequest =
  | { type: 'none' }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'question'; request: UserQuestionRequest };

/**
 * Session status - a discriminated union that makes invalid states unrepresentable.
 * Replaces separate running, stopping, loadingSession, and startingSession booleans.
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

/** Tool progress tracking for long-running tool executions */
export interface ToolProgressInfo {
  toolName: string;
  elapsedSeconds: number;
}

/** Task notification from SDK (e.g., Task tool subagent updates) */
export interface TaskNotification {
  id: string;
  message: string;
  timestamp: string;
}

export interface ChatState {
  /** Chat messages in the conversation */
  messages: ChatMessage[];
  /**
   * Session lifecycle status - a discriminated union that makes invalid states unrepresentable.
   * Replaces separate running, stopping, loadingSession, and startingSession booleans.
   */
  sessionStatus: SessionStatus;
  /** Current git branch for the session */
  gitBranch: string | null;
  /** Available Claude CLI sessions */
  availableSessions: SessionInfo[];
  /**
   * Pending interactive request awaiting user response.
   * Discriminated union ensures only one request type can be active at a time.
   */
  pendingRequest: PendingRequest;
  /** Chat settings (model, thinking, plan mode) */
  chatSettings: ChatSettings;
  /**
   * Queued messages waiting to be sent.
   * Map from message ID to QueuedMessage - enforces uniqueness by design.
   * Maps automatically de-dupe: adding the same ID twice simply overwrites.
   */
  queuedMessages: Map<string, QueuedMessage>;
  /** Tool use ID to message index map for O(1) updates */
  toolUseIdToIndex: Map<string, number>;
  /** Latest accumulated thinking content from extended thinking mode */
  latestThinking: string | null;
  /**
   * Pending messages awaiting backend confirmation (shown with "sending..." indicator).
   * Map from message ID to content. Presence in map = pending, content = for recovery on rejection.
   * Replaces separate pendingMessageIds Set and pendingMessageContent Map.
   */
  pendingMessages: Map<string, PendingMessageContent>;
  /** Last rejected message for recovery (allows restoring to input) */
  lastRejectedMessage: RejectedMessageInfo | null;
  /** Whether context compaction is in progress (placeholder for future SDK support) */
  isCompacting: boolean;
  /** Tool progress tracking for long-running tools - Map from tool_use_id to progress info */
  toolProgress: Map<string, ToolProgressInfo>;
  /** Task notifications from SDK (e.g., subagent updates) */
  taskNotifications: TaskNotification[];
  /** Current permission mode from SDK status updates */
  permissionMode: string | null;
}

// =============================================================================
// Action Types
// =============================================================================

export type ChatAction =
  // WebSocket message actions
  | { type: 'WS_STATUS'; payload: { running: boolean } }
  | { type: 'WS_STARTING' }
  | { type: 'WS_STARTED' }
  | { type: 'WS_STOPPED' }
  | { type: 'WS_CLAUDE_MESSAGE'; payload: ClaudeMessage }
  | { type: 'WS_ERROR'; payload: { message: string } }
  | { type: 'WS_SESSIONS'; payload: { sessions: SessionInfo[] } }
  | { type: 'WS_PERMISSION_REQUEST'; payload: PermissionRequest }
  | { type: 'WS_USER_QUESTION'; payload: UserQuestionRequest }
  // Session actions
  | { type: 'SESSION_SWITCH_START' }
  | { type: 'SESSION_LOADING_START' }
  // Tool input streaming action
  | { type: 'TOOL_INPUT_UPDATE'; payload: { toolUseId: string; input: Record<string, unknown> } }
  // Track tool use message index
  | { type: 'TOOL_USE_INDEXED'; payload: { toolUseId: string; index: number } }
  // Permission/question response actions
  | { type: 'PERMISSION_RESPONSE'; payload: { allow: boolean } }
  | { type: 'QUESTION_RESPONSE' }
  // Stop action
  | { type: 'STOP_REQUESTED' }
  // User message action
  | { type: 'USER_MESSAGE_SENT'; payload: ChatMessage }
  // Queue actions (optimistic local state)
  | { type: 'ADD_TO_QUEUE'; payload: QueuedMessage }
  | {
      type: 'MESSAGE_SENDING';
      payload: { id: string; text: string; attachments?: MessageAttachment[] };
    }
  | { type: 'CLEAR_REJECTED_MESSAGE' }
  // Message used as interactive response (clears pending request and adds message)
  | { type: 'MESSAGE_USED_AS_RESPONSE'; payload: { id: string; text: string; order?: number } }
  // Settings action
  | { type: 'UPDATE_SETTINGS'; payload: Partial<ChatSettings> }
  | { type: 'SET_SETTINGS'; payload: ChatSettings }
  // Thinking actions (extended thinking mode)
  | { type: 'THINKING_DELTA'; payload: { thinking: string } }
  | { type: 'THINKING_CLEAR' }
  // Clear/reset actions
  | { type: 'CLEAR_CHAT' }
  | { type: 'RESET_FOR_SESSION_SWITCH' }
  // Message state machine actions (primary protocol)
  | {
      type: 'MESSAGES_SNAPSHOT';
      payload: {
        /** Pre-built ChatMessages from backend - ready to use directly */
        messages: ChatMessage[];
        sessionStatus: SharedSessionStatus;
        pendingInteractiveRequest?: PendingInteractiveRequest | null;
      };
    }
  | {
      type: 'MESSAGE_STATE_CHANGED';
      payload: {
        id: string;
        newState: MessageState;
        queuePosition?: number;
        errorMessage?: string;
        // For ACCEPTED state, includes full message content so we can add it to the list
        userMessage?: {
          text: string;
          timestamp: string;
          attachments?: MessageAttachment[];
          settings?: ChatSettings;
          /** Backend-assigned order for reliable sorting */
          order?: number;
        };
      };
    }
  // SDK message type actions
  | { type: 'SDK_STATUS_UPDATE'; payload: { permissionMode?: string } }
  | {
      type: 'SDK_TOOL_PROGRESS';
      payload: { toolUseId: string; toolName: string; elapsedSeconds: number };
    }
  | { type: 'SDK_TOOL_USE_SUMMARY'; payload: { summary?: string; precedingToolUseIds: string[] } }
  | { type: 'SDK_TASK_NOTIFICATION'; payload: { message: string } }
  | { type: 'SDK_COMPACTING_START' }
  | { type: 'SDK_COMPACTING_END' }
  // Task notification management
  | { type: 'DISMISS_TASK_NOTIFICATION'; payload: { id: string } }
  | { type: 'CLEAR_TASK_NOTIFICATIONS' };

// =============================================================================
// Helper Functions
// =============================================================================

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createClaudeMessage(message: ClaudeMessage): ChatMessage {
  return {
    id: generateMessageId(),
    source: 'claude',
    message,
    timestamp: new Date().toISOString(),
  };
}

function createErrorMessage(error: string): ChatMessage {
  const errorMsg: ClaudeMessage = {
    type: 'error',
    error,
    timestamp: new Date().toISOString(),
  };
  return createClaudeMessage(errorMsg);
}

/**
 * Inserts a message into the messages array at the correct position based on order.
 * Uses binary search to find the insertion point for O(log n) performance.
 * Messages are ordered by their backend-assigned order (oldest first).
 * Messages without order are appended to the end.
 */
function insertMessageByOrder(messages: ChatMessage[], newMessage: ChatMessage): ChatMessage[] {
  // If new message has no order, append to end (local messages without backend confirmation)
  if (newMessage.order === undefined) {
    return [...messages, newMessage];
  }

  const newOrder = newMessage.order;

  // Binary search to find insertion point based on order
  let low = 0;
  let high = messages.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const midOrder = messages[mid].order;

    // Messages without order are treated as having Infinity order (should stay at end)
    // So when midOrder is undefined, we should NOT move right - the new message goes before it
    if (midOrder !== undefined && midOrder <= newOrder) {
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

// =============================================================================
// Initial State
// =============================================================================

/**
 * Creates the base reset state used by CLEAR_CHAT, RESET_FOR_SESSION_SWITCH,
 * and SESSION_SWITCH_START. This eliminates duplication and ensures all reset
 * actions clear the same fields consistently.
 */
function createBaseResetState(): Pick<
  ChatState,
  | 'messages'
  | 'gitBranch'
  | 'pendingRequest'
  | 'toolUseIdToIndex'
  | 'latestThinking'
  | 'pendingMessages'
  | 'lastRejectedMessage'
  | 'isCompacting'
  | 'toolProgress'
  | 'taskNotifications'
  | 'permissionMode'
> {
  return {
    messages: [],
    gitBranch: null,
    pendingRequest: { type: 'none' },
    toolUseIdToIndex: new Map(),
    latestThinking: null,
    pendingMessages: new Map(),
    lastRejectedMessage: null,
    isCompacting: false,
    toolProgress: new Map(),
    taskNotifications: [],
    permissionMode: null,
  };
}

/**
 * Creates extended reset state for session switches, which also clears
 * queue and session status.
 */
function createSessionSwitchResetState(): Pick<
  ChatState,
  | 'messages'
  | 'gitBranch'
  | 'pendingRequest'
  | 'toolUseIdToIndex'
  | 'latestThinking'
  | 'pendingMessages'
  | 'lastRejectedMessage'
  | 'queuedMessages'
  | 'sessionStatus'
  | 'isCompacting'
  | 'toolProgress'
  | 'taskNotifications'
  | 'permissionMode'
> {
  return {
    ...createBaseResetState(),
    queuedMessages: new Map(),
    sessionStatus: { phase: 'loading' },
  };
}

export function createInitialChatState(overrides?: Partial<ChatState>): ChatState {
  return {
    messages: [],
    sessionStatus: { phase: 'loading' },
    gitBranch: null,
    availableSessions: [],
    pendingRequest: { type: 'none' },
    chatSettings: DEFAULT_CHAT_SETTINGS,
    queuedMessages: new Map(),
    toolUseIdToIndex: new Map(),
    latestThinking: null,
    pendingMessages: new Map(),
    lastRejectedMessage: null,
    isCompacting: false,
    toolProgress: new Map(),
    taskNotifications: [],
    permissionMode: null,
    ...overrides,
  };
}

// =============================================================================
// Reducer Helper Functions
// =============================================================================

/**
 * Convert a PendingInteractiveRequest from the backend to a PendingRequest for UI state.
 */
function convertPendingRequest(req: PendingInteractiveRequest | null | undefined): PendingRequest {
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

/**
 * Handle WS_CLAUDE_MESSAGE action - processes Claude messages and stores them.
 */
function handleClaudeMessage(state: ChatState, claudeMsg: ClaudeMessage): ChatState {
  // Transition from starting to running when receiving a Claude message
  let baseState: ChatState =
    state.sessionStatus.phase === 'starting'
      ? { ...state, sessionStatus: { phase: 'running' } }
      : state;

  // Set to ready when we receive a result
  if (claudeMsg.type === 'result') {
    baseState = { ...baseState, sessionStatus: { phase: 'ready' } };
  }

  // Check if message should be stored
  if (!shouldStoreMessage(claudeMsg)) {
    return baseState;
  }

  // Create and add the message
  const chatMessage = createClaudeMessage(claudeMsg);
  const newMessages = [...baseState.messages, chatMessage];
  const newIndex = newMessages.length - 1;

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
function handleToolInputUpdate(
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

// =============================================================================
// Reducer
// =============================================================================

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Reducer handles many action types by design
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    // WebSocket status messages
    case 'WS_STATUS':
      // WS_STATUS updates running state - transition to running or ready based on payload
      return {
        ...state,
        sessionStatus: action.payload.running ? { phase: 'running' } : { phase: 'ready' },
      };
    case 'WS_STARTING':
      return { ...state, sessionStatus: { phase: 'starting' } };
    case 'WS_STARTED':
      return { ...state, sessionStatus: { phase: 'running' }, latestThinking: null };
    case 'WS_STOPPED':
      // Clear toolProgress and isCompacting when session stops to prevent stale indicators
      return {
        ...state,
        sessionStatus: { phase: 'ready' },
        toolProgress: new Map(),
        isCompacting: false,
      };

    // Claude message handling (delegated to helper)
    case 'WS_CLAUDE_MESSAGE':
      return handleClaudeMessage(state, action.payload);

    // Error message
    case 'WS_ERROR':
      return {
        ...state,
        messages: [...state.messages, createErrorMessage(action.payload.message)],
      };

    // Session management
    case 'WS_SESSIONS':
      return { ...state, availableSessions: action.payload.sessions };

    // Permission and question requests
    // Always accept new requests (overwriting existing) to match backend behavior.
    // Discriminated union naturally prevents both types being active simultaneously.
    case 'WS_PERMISSION_REQUEST':
      return { ...state, pendingRequest: { type: 'permission', request: action.payload } };
    case 'WS_USER_QUESTION':
      return { ...state, pendingRequest: { type: 'question', request: action.payload } };

    case 'PERMISSION_RESPONSE': {
      // If ExitPlanMode was approved, disable plan mode in settings
      const shouldDisablePlanMode =
        action.payload.allow &&
        state.pendingRequest.type === 'permission' &&
        state.pendingRequest.request.toolName === 'ExitPlanMode';
      return {
        ...state,
        pendingRequest: { type: 'none' },
        ...(shouldDisablePlanMode && {
          chatSettings: { ...state.chatSettings, planModeEnabled: false },
        }),
      };
    }
    case 'QUESTION_RESPONSE':
      return { ...state, pendingRequest: { type: 'none' } };

    // Session switching
    case 'SESSION_SWITCH_START':
      return {
        ...state,
        ...createSessionSwitchResetState(),
      };
    case 'SESSION_LOADING_START':
      return { ...state, sessionStatus: { phase: 'loading' } };

    // Tool input streaming (delegated to helper)
    case 'TOOL_INPUT_UPDATE':
      return handleToolInputUpdate(state, action.payload.toolUseId, action.payload.input);
    case 'TOOL_USE_INDEXED': {
      const newToolUseIdToIndex = new Map(state.toolUseIdToIndex);
      newToolUseIdToIndex.set(action.payload.toolUseId, action.payload.index);
      return { ...state, toolUseIdToIndex: newToolUseIdToIndex };
    }

    // Stop request
    case 'STOP_REQUESTED':
      return { ...state, sessionStatus: { phase: 'stopping' } };

    // User messages
    case 'USER_MESSAGE_SENT':
      return { ...state, messages: [...state.messages, action.payload] };

    // Queue management (optimistic local state)
    // ADD_TO_QUEUE: Optimistically add message to queuedMessages for queue display
    case 'ADD_TO_QUEUE': {
      const newQueuedMessages = new Map(state.queuedMessages);
      newQueuedMessages.set(action.payload.id, action.payload);
      return {
        ...state,
        queuedMessages: newQueuedMessages,
      };
    }

    // MESSAGE_SENDING: Store content for recovery if rejected.
    // Message will be added to messages array when backend confirms with ACCEPTED state.
    case 'MESSAGE_SENDING': {
      const { id, text, attachments } = action.payload;

      // Store content in pendingMessages for recovery if rejected
      const newPendingMessages = new Map(state.pendingMessages);
      newPendingMessages.set(id, { text, attachments });

      return {
        ...state,
        pendingMessages: newPendingMessages,
      };
    }

    // CLEAR_REJECTED_MESSAGE: Clear the rejected message after user has seen it
    case 'CLEAR_REJECTED_MESSAGE':
      return {
        ...state,
        lastRejectedMessage: null,
      };

    // MESSAGE_USED_AS_RESPONSE: Message was used as a response to pending interactive request
    // Adds message to chat and clears the pending request
    // De-duplication: Skip adding if message ID already exists (handles reconnect/multi-tab scenarios)
    case 'MESSAGE_USED_AS_RESPONSE': {
      // Get pending content to preserve attachments before removing
      const pendingContent = state.pendingMessages.get(action.payload.id);

      // Remove from pending messages
      const newPendingMessages = new Map(state.pendingMessages);
      newPendingMessages.delete(action.payload.id);

      // De-dupe check: Skip if message already exists in messages array
      if (state.messages.some((m) => m.id === action.payload.id)) {
        // Still clear pending state since this was handled
        return {
          ...state,
          pendingMessages: newPendingMessages,
          pendingRequest: { type: 'none' },
        };
      }

      // Create user message, preserving attachments from pending state
      const userMessage: ChatMessage = {
        id: action.payload.id,
        source: 'user',
        text: action.payload.text,
        timestamp: new Date().toISOString(),
        attachments: pendingContent?.attachments,
        order: action.payload.order,
      };

      return {
        ...state,
        messages: insertMessageByOrder(state.messages, userMessage),
        pendingMessages: newPendingMessages,
        pendingRequest: { type: 'none' },
      };
    }

    // Settings
    case 'UPDATE_SETTINGS':
      return { ...state, chatSettings: { ...state.chatSettings, ...action.payload } };
    case 'SET_SETTINGS':
      return { ...state, chatSettings: action.payload };

    // Thinking (extended thinking mode)
    case 'THINKING_DELTA':
      return {
        ...state,
        latestThinking: (state.latestThinking ?? '') + action.payload.thinking,
      };
    case 'THINKING_CLEAR':
      return { ...state, latestThinking: null };

    // Clear/reset
    case 'CLEAR_CHAT': {
      // Preserve running state, but reset stopping/starting to ready
      const sessionStatus: SessionStatus =
        state.sessionStatus.phase === 'running' ? state.sessionStatus : { phase: 'ready' };
      return {
        ...state,
        ...createBaseResetState(),
        sessionStatus,
        chatSettings: DEFAULT_CHAT_SETTINGS,
      };
    }
    case 'RESET_FOR_SESSION_SWITCH':
      return {
        ...state,
        ...createSessionSwitchResetState(),
      };

    // New message state machine actions
    case 'MESSAGES_SNAPSHOT': {
      // Messages come pre-built from backend - just use them directly
      const snapshotMessages = action.payload.messages;

      // Build set of message IDs from backend snapshot for pending message cleanup
      const snapshotIds = new Set(snapshotMessages.map((m) => m.id));

      // Keep pending messages that haven't been acknowledged by backend yet
      const newPendingMessages = new Map<string, PendingMessageContent>();
      for (const [id, content] of state.pendingMessages) {
        if (!snapshotIds.has(id)) {
          newPendingMessages.set(id, content);
        }
      }

      // Session status comes from backend, which knows about queued messages
      const sessionStatus: SessionStatus = action.payload.sessionStatus;

      // Convert pending interactive request to UI state format
      const pendingRequest = convertPendingRequest(action.payload.pendingInteractiveRequest);

      // Note: queuedMessages are now managed via MESSAGE_STATE_CHANGED events.
      // The snapshot contains final ChatMessages, not intermediate states.
      // Clear queuedMessages since snapshot represents fully processed state.
      return {
        ...state,
        messages: snapshotMessages,
        queuedMessages: new Map(),
        sessionStatus,
        pendingRequest,
        toolUseIdToIndex: new Map(),
        pendingMessages: newPendingMessages,
        lastRejectedMessage: null,
      };
    }

    case 'MESSAGE_STATE_CHANGED': {
      const { id, newState, userMessage, errorMessage } = action.payload;

      // ACCEPTED: Add message to list and queue
      // De-duplication: Skip adding if message ID already exists (handles reconnect/multi-tab scenarios)
      if (newState === MessageState.ACCEPTED && userMessage) {
        const newPendingMessages = new Map(state.pendingMessages);
        newPendingMessages.delete(id);

        // Check if message already exists (e.g., from reconnect or multi-tab)
        if (state.messages.some((m) => m.id === id)) {
          // Still need to update queue and clear pending state
          const newQueuedMessages = new Map(state.queuedMessages);
          newQueuedMessages.set(id, {
            id,
            text: userMessage.text,
            timestamp: userMessage.timestamp,
            attachments: userMessage.attachments,
            settings: userMessage.settings ?? {
              selectedModel: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
          });
          return {
            ...state,
            queuedMessages: newQueuedMessages,
            pendingMessages: newPendingMessages,
          };
        }

        const newMessage: ChatMessage = {
          id,
          source: 'user',
          text: userMessage.text,
          timestamp: userMessage.timestamp,
          attachments: userMessage.attachments,
          order: userMessage.order,
        };

        const newQueuedMessages = new Map(state.queuedMessages);
        newQueuedMessages.set(id, {
          id,
          text: userMessage.text,
          timestamp: userMessage.timestamp,
          attachments: userMessage.attachments,
          settings: userMessage.settings ?? {
            selectedModel: null,
            thinkingEnabled: false,
            planModeEnabled: false,
          },
        });

        return {
          ...state,
          messages: insertMessageByOrder(state.messages, newMessage),
          queuedMessages: newQueuedMessages,
          pendingMessages: newPendingMessages,
        };
      }

      // DISPATCHED, COMMITTED, COMPLETE: Remove from queue
      if (
        newState === MessageState.DISPATCHED ||
        newState === MessageState.COMMITTED ||
        newState === MessageState.COMPLETE
      ) {
        const newQueuedMessages = new Map(state.queuedMessages);
        newQueuedMessages.delete(id);
        return { ...state, queuedMessages: newQueuedMessages };
      }

      // CANCELLED: Remove from queue and messages
      if (newState === MessageState.CANCELLED) {
        const newQueuedMessages = new Map(state.queuedMessages);
        newQueuedMessages.delete(id);
        return {
          ...state,
          messages: state.messages.filter((m) => m.id !== id),
          queuedMessages: newQueuedMessages,
        };
      }

      // REJECTED, FAILED: Remove from queue/messages, save for recovery
      if (newState === MessageState.REJECTED || newState === MessageState.FAILED) {
        const queuedMessage = state.queuedMessages.get(id);
        const pendingContent = state.pendingMessages.get(id);
        const recoveryContent = queuedMessage ?? pendingContent;

        const newQueuedMessages = new Map(state.queuedMessages);
        newQueuedMessages.delete(id);

        const newPendingMessages = new Map(state.pendingMessages);
        newPendingMessages.delete(id);

        return {
          ...state,
          messages: state.messages.filter((m) => m.id !== id),
          queuedMessages: newQueuedMessages,
          pendingMessages: newPendingMessages,
          lastRejectedMessage: recoveryContent
            ? {
                text: queuedMessage?.text ?? pendingContent?.text ?? '',
                attachments: recoveryContent.attachments,
                error: errorMessage ?? 'Message failed',
              }
            : null,
        };
      }

      // Ignore other state transitions (SENT, PENDING, STREAMING) - tracked by backend
      debug.log(`[chat-reducer] Ignoring state transition to ${newState} for message ${id}`);
      return state;
    }

    // SDK message type actions
    case 'SDK_STATUS_UPDATE':
      // Track permissionMode changes from SDK status updates
      return {
        ...state,
        permissionMode: action.payload.permissionMode ?? state.permissionMode,
      };

    case 'SDK_TOOL_PROGRESS': {
      const { toolUseId, toolName, elapsedSeconds } = action.payload;
      const newToolProgress = new Map(state.toolProgress);
      newToolProgress.set(toolUseId, { toolName, elapsedSeconds });
      return { ...state, toolProgress: newToolProgress };
    }

    case 'SDK_TOOL_USE_SUMMARY': {
      // When we get a tool use summary, clear the progress for those tools
      const { precedingToolUseIds } = action.payload;
      const newToolProgress = new Map(state.toolProgress);
      for (const toolUseId of precedingToolUseIds) {
        newToolProgress.delete(toolUseId);
      }
      return { ...state, toolProgress: newToolProgress };
    }

    case 'SDK_TASK_NOTIFICATION': {
      // Append new task notification with UUID to avoid collisions under bursty updates
      const newNotification: TaskNotification = {
        id: crypto.randomUUID(),
        message: action.payload.message,
        timestamp: new Date().toISOString(),
      };
      return {
        ...state,
        taskNotifications: [...state.taskNotifications, newNotification],
      };
    }

    case 'SDK_COMPACTING_START':
      return { ...state, isCompacting: true };

    case 'SDK_COMPACTING_END':
      return { ...state, isCompacting: false };

    case 'DISMISS_TASK_NOTIFICATION':
      return {
        ...state,
        taskNotifications: state.taskNotifications.filter(
          (notif) => notif.id !== action.payload.id
        ),
      };

    case 'CLEAR_TASK_NOTIFICATIONS':
      return { ...state, taskNotifications: [] };

    default:
      return state;
  }
}

// =============================================================================
// Action Creators (for type-safe dispatch)
// =============================================================================

// Individual message type handlers for createActionFromWebSocketMessage

function handleStatusMessage(data: WebSocketMessage): ChatAction {
  return { type: 'WS_STATUS', payload: { running: data.running ?? false } };
}

function handleClaudeMessageAction(data: WebSocketMessage): ChatAction | null {
  if (isWsClaudeMessage(data)) {
    return { type: 'WS_CLAUDE_MESSAGE', payload: data.data };
  }
  return null;
}

function handleErrorMessageAction(data: WebSocketMessage): ChatAction | null {
  if (data.message) {
    return { type: 'WS_ERROR', payload: { message: data.message } };
  }
  return null;
}

function handleSessionsMessage(data: WebSocketMessage): ChatAction | null {
  if (data.sessions) {
    return { type: 'WS_SESSIONS', payload: { sessions: data.sessions } };
  }
  return null;
}

function handlePermissionRequestMessage(data: WebSocketMessage): ChatAction | null {
  if (data.requestId && data.toolName) {
    return {
      type: 'WS_PERMISSION_REQUEST',
      payload: {
        requestId: data.requestId,
        toolName: data.toolName,
        toolInput: data.toolInput ?? {},
        timestamp: new Date().toISOString(),
        // Include plan content for ExitPlanMode requests
        planContent: data.planContent ?? null,
      },
    };
  }
  return null;
}

function handleUserQuestionMessage(data: WebSocketMessage): ChatAction | null {
  if (data.requestId && data.questions) {
    return {
      type: 'WS_USER_QUESTION',
      payload: {
        requestId: data.requestId,
        questions: data.questions,
        timestamp: new Date().toISOString(),
      },
    };
  }
  return null;
}

function handleMessagesSnapshot(data: WebSocketMessage): ChatAction | null {
  if (!data.messages) {
    return null;
  }
  return {
    type: 'MESSAGES_SNAPSHOT',
    payload: {
      messages: data.messages,
      sessionStatus: data.sessionStatus ?? { phase: 'ready' },
      pendingInteractiveRequest: data.pendingInteractiveRequest ?? null,
    },
  };
}

function handleMessageStateChanged(data: WebSocketMessage): ChatAction | null {
  if (!(data.id && data.newState)) {
    return null;
  }
  return {
    type: 'MESSAGE_STATE_CHANGED',
    payload: {
      id: data.id,
      newState: data.newState,
      queuePosition: data.queuePosition,
      errorMessage: data.errorMessage,
      userMessage: data.userMessage,
    },
  };
}

function handleToolProgressMessage(data: WebSocketMessage): ChatAction | null {
  if (!(data.tool_use_id && data.tool_name && data.elapsed_time_seconds !== undefined)) {
    return null;
  }
  return {
    type: 'SDK_TOOL_PROGRESS',
    payload: {
      toolUseId: data.tool_use_id,
      toolName: data.tool_name,
      elapsedSeconds: data.elapsed_time_seconds,
    },
  };
}

function handleToolUseSummaryMessage(data: WebSocketMessage): ChatAction | null {
  // Only require preceding_tool_use_ids (used for cleanup). Summary can be empty string.
  if (!Array.isArray(data.preceding_tool_use_ids)) {
    return null;
  }
  return {
    type: 'SDK_TOOL_USE_SUMMARY',
    payload: {
      summary: data.summary,
      precedingToolUseIds: data.preceding_tool_use_ids,
    },
  };
}

/**
 * Creates a ChatAction from a WebSocketMessage.
 * Returns null if the message type is not handled.
 */
export function createActionFromWebSocketMessage(data: WebSocketMessage): ChatAction | null {
  switch (data.type) {
    case 'status':
      return handleStatusMessage(data);
    case 'starting':
      return { type: 'WS_STARTING' };
    case 'started':
      return { type: 'WS_STARTED' };
    case 'stopped':
    case 'process_exit':
      return { type: 'WS_STOPPED' };
    case 'claude_message':
      return handleClaudeMessageAction(data);
    case 'error':
      return handleErrorMessageAction(data);
    case 'sessions':
      return handleSessionsMessage(data);
    case 'permission_request':
      return handlePermissionRequestMessage(data);
    case 'user_question':
      return handleUserQuestionMessage(data);
    // Interactive response handling
    case 'message_used_as_response':
      return data.id && data.text
        ? {
            type: 'MESSAGE_USED_AS_RESPONSE',
            payload: { id: data.id, text: data.text, order: data.order },
          }
        : null;
    // Message state machine events (primary protocol)
    case 'messages_snapshot':
      return handleMessagesSnapshot(data);
    case 'message_state_changed':
      return handleMessageStateChanged(data);
    // SDK message type events
    case 'tool_progress':
      return handleToolProgressMessage(data);
    case 'tool_use_summary':
      return handleToolUseSummaryMessage(data);
    case 'status_update':
      return { type: 'SDK_STATUS_UPDATE', payload: { permissionMode: data.permissionMode } };
    case 'task_notification':
      return data.message
        ? { type: 'SDK_TASK_NOTIFICATION', payload: { message: data.message } }
        : null;
    // Context compaction events
    case 'compacting_start':
      return { type: 'SDK_COMPACTING_START' };
    case 'compacting_end':
      return { type: 'SDK_COMPACTING_END' };
    default:
      return null;
  }
}

/**
 * Creates a user message action.
 */
export function createUserMessageAction(text: string): ChatAction {
  const chatMessage: ChatMessage = {
    id: generateMessageId(),
    source: 'user',
    text,
    timestamp: new Date().toISOString(),
  };
  return { type: 'USER_MESSAGE_SENT', payload: chatMessage };
}
