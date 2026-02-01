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
  HistoryMessage,
  MessageAttachment,
  PendingInteractiveRequest,
  PermissionRequest,
  QueuedMessage,
  SessionInfo,
  UserQuestionRequest,
  WebSocketMessage,
} from '@/lib/claude-types';
import { convertHistoryMessage, DEFAULT_CHAT_SETTINGS } from '@/lib/claude-types';

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
  | {
      type: 'WS_SESSION_LOADED';
      payload: {
        messages: HistoryMessage[];
        gitBranch: string | null;
        running: boolean;
        settings?: ChatSettings;
        pendingInteractiveRequest?: PendingInteractiveRequest | null;
        queuedMessages?: QueuedMessage[];
      };
    }
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
  // Queue actions (backend-managed queue)
  | { type: 'ADD_TO_QUEUE'; payload: QueuedMessage }
  | { type: 'MESSAGE_QUEUED'; payload: { id: string; position: number } }
  | { type: 'MESSAGE_DISPATCHED'; payload: { id: string } }
  | { type: 'MESSAGE_REMOVED'; payload: { id: string } }
  | { type: 'SET_QUEUE'; payload: QueuedMessage[] }
  | { type: 'MESSAGE_ACCEPTED'; payload: { id: string; position: number; message: QueuedMessage } }
  | { type: 'MESSAGE_REJECTED'; payload: { id: string; error: string } }
  | {
      type: 'MESSAGE_SENDING';
      payload: { id: string; text: string; attachments?: MessageAttachment[] };
    }
  | { type: 'CLEAR_REJECTED_MESSAGE' }
  // Message used as interactive response (clears pending request and adds message)
  | { type: 'MESSAGE_USED_AS_RESPONSE'; payload: { id: string; text: string } }
  // Settings action
  | { type: 'UPDATE_SETTINGS'; payload: Partial<ChatSettings> }
  | { type: 'SET_SETTINGS'; payload: ChatSettings }
  // Thinking actions (extended thinking mode)
  | { type: 'THINKING_DELTA'; payload: { thinking: string } }
  | { type: 'THINKING_CLEAR' }
  // Clear/reset actions
  | { type: 'CLEAR_CHAT' }
  | { type: 'RESET_FOR_SESSION_SWITCH' };

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
  if (claudeMsg.type !== 'stream_event') {
    return true;
  }

  const event = (claudeMsg as { event?: { type?: string; content_block?: { type?: string } } })
    .event;
  if (!event) {
    return false;
  }

  // Only store content_block_start for tool_use, tool_result, and thinking
  if (event.type === 'content_block_start' && event.content_block) {
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
  return (
    claudeMsg.type === 'stream_event' &&
    claudeMsg.event?.type === 'content_block_start' &&
    claudeMsg.event.content_block?.type === 'tool_use' &&
    (claudeMsg.event.content_block as { id?: string }).id === toolUseId
  );
}

/**
 * Gets the tool use ID from a Claude message if it's a tool_use start event.
 */
function getToolUseIdFromMessage(claudeMsg: ClaudeMessage): string | null {
  if (
    claudeMsg.type === 'stream_event' &&
    claudeMsg.event?.type === 'content_block_start' &&
    claudeMsg.event.content_block?.type === 'tool_use'
  ) {
    return (claudeMsg.event.content_block as { id?: string }).id ?? null;
  }
  return null;
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
> {
  return {
    messages: [],
    gitBranch: null,
    pendingRequest: { type: 'none' },
    toolUseIdToIndex: new Map(),
    latestThinking: null,
    pendingMessages: new Map(),
    lastRejectedMessage: null,
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
    sessionStatus: { phase: 'idle' },
    gitBranch: null,
    availableSessions: [],
    pendingRequest: { type: 'none' },
    chatSettings: DEFAULT_CHAT_SETTINGS,
    queuedMessages: new Map(),
    toolUseIdToIndex: new Map(),
    latestThinking: null,
    pendingMessages: new Map(),
    lastRejectedMessage: null,
    ...overrides,
  };
}

// =============================================================================
// Reducer Helper Functions
// =============================================================================

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

  // Fallback to linear scan if not found
  if (messageIndex === undefined) {
    messageIndex = state.messages.findIndex((msg) => isToolUseMessageWithId(msg, toolUseId));
    if (messageIndex === -1) {
      return state; // Tool use not found
    }
    // Update index for future lookups - create new state with updated index
    const newToolUseIdToIndex = new Map(state.toolUseIdToIndex);
    newToolUseIdToIndex.set(toolUseId, messageIndex);
    currentState = { ...state, toolUseIdToIndex: newToolUseIdToIndex };
  }

  const msg = currentState.messages[messageIndex];
  if (!isToolUseMessageWithId(msg, toolUseId)) {
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
      return { ...state, sessionStatus: { phase: 'ready' } };

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
    case 'WS_SESSION_LOADED': {
      const historyMessages = action.payload.messages.map(convertHistoryMessage);

      // Preserve any optimistic user messages that were sent after the last history message
      // This handles the case where the user sends a message and navigates away before
      // the session processes it. We identify these by checking if the message timestamp
      // is after the last message in history.
      const lastHistoryTime =
        historyMessages.length > 0
          ? new Date(historyMessages[historyMessages.length - 1].timestamp).getTime()
          : 0;

      const optimisticUserMessages = state.messages.filter((msg) => {
        if (msg.source !== 'user' || msg.text === undefined) {
          return false;
        }

        // Keep messages that are newer than the last history message
        const msgTime = new Date(msg.timestamp).getTime();
        return msgTime > lastHistoryTime;
      });

      // Combine history with any optimistic messages (optimistic messages come after history)
      const messages =
        optimisticUserMessages.length > 0
          ? [...historyMessages, ...optimisticUserMessages]
          : historyMessages;

      // Restore pending interactive request if present from backend.
      // Only overwrite existing state if backend has something to restore,
      // otherwise preserve any pending state that may have arrived during loading (race condition fix).
      const pendingReq = action.payload.pendingInteractiveRequest;
      let pendingRequest: PendingRequest = state.pendingRequest;

      if (pendingReq) {
        if (pendingReq.toolName === 'AskUserQuestion') {
          // Restore AskUserQuestion modal
          const input = pendingReq.input as { questions?: unknown[] };
          pendingRequest = {
            type: 'question',
            request: {
              requestId: pendingReq.requestId,
              questions: (input.questions ?? []) as UserQuestionRequest['questions'],
              timestamp: pendingReq.timestamp,
            },
          };
        } else {
          // Restore permission request (ExitPlanMode or other)
          pendingRequest = {
            type: 'permission',
            request: {
              requestId: pendingReq.requestId,
              toolName: pendingReq.toolName,
              toolInput: pendingReq.input,
              timestamp: pendingReq.timestamp,
              planContent: pendingReq.planContent,
            },
          };
        }
      }

      // Convert incoming array to Map for O(1) lookups and automatic de-duplication
      const queuedMessagesArray = action.payload.queuedMessages ?? [];
      const queuedMessagesMap = new Map<string, QueuedMessage>();
      for (const msg of queuedMessagesArray) {
        queuedMessagesMap.set(msg.id, msg);
      }

      // Convert queued messages to ChatMessages for inline display
      // These will appear grayed out at the end of the messages list
      // Filter out any that are already in messages to prevent duplicates
      // (can happen if optimistic messages overlap with backend queued messages)
      const existingMessageIds = new Set(messages.map((m) => m.id));
      const queuedAsChatMessages: ChatMessage[] = queuedMessagesArray
        .filter((qm) => !existingMessageIds.has(qm.id))
        .map((qm) => ({
          id: qm.id,
          source: 'user' as const,
          text: qm.text,
          timestamp: qm.timestamp,
          attachments: qm.attachments,
        }));

      // Combine history + optimistic + queued messages (deduplicated)
      const allMessages = [...messages, ...queuedAsChatMessages];

      return {
        ...state,
        messages: allMessages,
        gitBranch: action.payload.gitBranch,
        // Session is ready (or running if backend says so)
        sessionStatus: action.payload.running ? { phase: 'running' } : { phase: 'ready' },
        toolUseIdToIndex: new Map(),
        pendingRequest,
        // Restore queued messages from backend (converted to Map)
        queuedMessages: queuedMessagesMap,
        // Clear pending message state to remove stale indicators and prevent memory leaks
        pendingMessages: new Map(),
        // Clear stale rejected message to prevent recovery effect from restoring old content
        lastRejectedMessage: null,
      };
    }

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

    // Queue management (backend-managed queue)
    // ADD_TO_QUEUE: Optimistically add message to queuedMessages for queue display
    case 'ADD_TO_QUEUE': {
      const newQueuedMessages = new Map(state.queuedMessages);
      newQueuedMessages.set(action.payload.id, action.payload);
      return {
        ...state,
        queuedMessages: newQueuedMessages,
      };
    }

    // MESSAGE_QUEUED: Acknowledgment from backend - message is in queue
    // With optimistic UI, the message is already in chat messages and queuedMessages, no state change needed
    case 'MESSAGE_QUEUED':
      return state;

    // MESSAGE_DISPATCHED: Backend is sending message to Claude
    // Remove from queuedMessages (no longer pending), message stays in chat
    case 'MESSAGE_DISPATCHED': {
      const newQueuedMessages = new Map(state.queuedMessages);
      newQueuedMessages.delete(action.payload.id);
      return {
        ...state,
        queuedMessages: newQueuedMessages,
      };
    }

    // MESSAGE_REMOVED: User cancelled a queued message before dispatch
    // Remove from both queue display and chat messages (undo optimistic update)
    case 'MESSAGE_REMOVED': {
      const newQueuedMessages = new Map(state.queuedMessages);
      newQueuedMessages.delete(action.payload.id);
      return {
        ...state,
        messages: state.messages.filter((m) => m.id !== action.payload.id),
        queuedMessages: newQueuedMessages,
      };
    }

    // MESSAGE_ACCEPTED: Backend confirmed message is in queue
    // Add to messages and queuedMessages, remove from pending
    // De-duplication: Skip if message ID already exists (handles reconnect/multi-tab scenarios)
    case 'MESSAGE_ACCEPTED': {
      const queuedMsg = action.payload.message;

      // De-dupe check: Skip if message already exists in messages array
      if (state.messages.some((m) => m.id === queuedMsg.id)) {
        // Still remove from pending since backend confirmed it
        const newPendingMessages = new Map(state.pendingMessages);
        newPendingMessages.delete(action.payload.id);
        return { ...state, pendingMessages: newPendingMessages };
      }

      const newPendingMessages = new Map(state.pendingMessages);
      newPendingMessages.delete(action.payload.id);

      // Create user message from queued message
      const userMessage: ChatMessage = {
        id: queuedMsg.id,
        source: 'user',
        text: queuedMsg.text,
        timestamp: queuedMsg.timestamp,
        attachments: queuedMsg.attachments,
      };

      // Add to queuedMessages Map - automatically de-dupes by ID
      const newQueuedMessages = new Map(state.queuedMessages);
      newQueuedMessages.set(queuedMsg.id, queuedMsg);

      return {
        ...state,
        messages: [...state.messages, userMessage],
        queuedMessages: newQueuedMessages,
        pendingMessages: newPendingMessages,
      };
    }

    // MESSAGE_REJECTED: Backend rejected message (queue full, etc.)
    // Remove from pending and store for recovery so user can retry
    case 'MESSAGE_REJECTED': {
      // Retrieve pending content for recovery before deleting
      const pendingContent = state.pendingMessages.get(action.payload.id);
      const newPendingMessages = new Map(state.pendingMessages);
      newPendingMessages.delete(action.payload.id);
      return {
        ...state,
        pendingMessages: newPendingMessages,
        // Store rejected message info for recovery (restore to input)
        lastRejectedMessage: pendingContent
          ? {
              text: pendingContent.text,
              attachments: pendingContent.attachments,
              error: action.payload.error,
            }
          : null,
      };
    }

    // MESSAGE_SENDING: Mark a message as pending backend confirmation and store content for recovery
    case 'MESSAGE_SENDING': {
      const newPendingMessages = new Map(state.pendingMessages);
      newPendingMessages.set(action.payload.id, {
        text: action.payload.text,
        attachments: action.payload.attachments,
      });
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
    case 'MESSAGE_USED_AS_RESPONSE': {
      // Remove from pending messages
      const newPendingMessages = new Map(state.pendingMessages);
      newPendingMessages.delete(action.payload.id);

      // Create user message
      const userMessage: ChatMessage = {
        id: action.payload.id,
        source: 'user',
        text: action.payload.text,
        timestamp: new Date().toISOString(),
      };

      return {
        ...state,
        messages: [...state.messages, userMessage],
        pendingMessages: newPendingMessages,
        pendingRequest: { type: 'none' },
      };
    }

    // SET_QUEUE: Restore queue state from backend (on reconnect/session load)
    case 'SET_QUEUE': {
      const queuedMessagesMap = new Map<string, QueuedMessage>();
      for (const msg of action.payload) {
        queuedMessagesMap.set(msg.id, msg);
      }
      return { ...state, queuedMessages: queuedMessagesMap };
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
  if (data.data) {
    return { type: 'WS_CLAUDE_MESSAGE', payload: data.data as ClaudeMessage };
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

function handleSessionLoadedMessage(data: WebSocketMessage): ChatAction {
  return {
    type: 'WS_SESSION_LOADED',
    payload: {
      messages: (data.messages as HistoryMessage[]) ?? [],
      gitBranch: data.gitBranch ?? null,
      running: data.running ?? false,
      settings: data.settings,
      pendingInteractiveRequest: data.pendingInteractiveRequest ?? null,
      queuedMessages: data.queuedMessages ?? [],
    },
  };
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

function handleMessageQueuedAction(data: WebSocketMessage): ChatAction | null {
  if (!data.id) {
    return null;
  }
  return { type: 'MESSAGE_QUEUED', payload: { id: data.id, position: data.position ?? 0 } };
}

function handleMessageAcceptedAction(data: WebSocketMessage): ChatAction | null {
  if (!(data.id && data.queuedMessage)) {
    return null;
  }
  return {
    type: 'MESSAGE_ACCEPTED',
    payload: { id: data.id, position: data.position ?? 0, message: data.queuedMessage },
  };
}

function handleMessageQueueAction(data: WebSocketMessage): ChatAction | null {
  switch (data.type) {
    case 'message_queued':
      return handleMessageQueuedAction(data);
    case 'message_dispatched':
      return data.id ? { type: 'MESSAGE_DISPATCHED', payload: { id: data.id } } : null;
    case 'message_removed':
      return data.id ? { type: 'MESSAGE_REMOVED', payload: { id: data.id } } : null;
    case 'message_accepted':
      return handleMessageAcceptedAction(data);
    case 'message_rejected':
      return data.id
        ? { type: 'MESSAGE_REJECTED', payload: { id: data.id, error: data.message ?? '' } }
        : null;
    case 'message_used_as_response':
      return data.id && data.text
        ? { type: 'MESSAGE_USED_AS_RESPONSE', payload: { id: data.id, text: data.text } }
        : null;
    case 'interactive_response_cleared':
      return { type: 'QUESTION_RESPONSE' };
    default:
      return null;
  }
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
    case 'session_loaded':
      return handleSessionLoadedMessage(data);
    case 'permission_request':
      return handlePermissionRequestMessage(data);
    case 'user_question':
      return handleUserQuestionMessage(data);
    // Queue and interactive response events from backend
    case 'message_queued':
    case 'message_dispatched':
    case 'message_removed':
    case 'message_accepted':
    case 'message_rejected':
    case 'message_used_as_response':
    case 'interactive_response_cleared':
      return handleMessageQueueAction(data);
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
