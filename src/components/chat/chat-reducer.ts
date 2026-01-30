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

export interface ChatState {
  /** Chat messages in the conversation */
  messages: ChatMessage[];
  /** Whether Claude is currently processing */
  running: boolean;
  /** Whether a stop request is in progress */
  stopping: boolean;
  /** Current git branch for the session */
  gitBranch: string | null;
  /** Available Claude CLI sessions */
  availableSessions: SessionInfo[];
  /** Pending permission request awaiting user response */
  pendingPermission: PermissionRequest | null;
  /** Pending user question awaiting user response */
  pendingQuestion: UserQuestionRequest | null;
  /** Whether session is currently loading */
  loadingSession: boolean;
  /** Whether Claude CLI is starting up */
  startingSession: boolean;
  /** Chat settings (model, thinking, plan mode) */
  chatSettings: ChatSettings;
  /** Queued messages waiting to be sent */
  queuedMessages: QueuedMessage[];
  /** Tool use ID to message index map for O(1) updates */
  toolUseIdToIndex: Map<string, number>;
  /** Latest accumulated thinking content from extended thinking mode */
  latestThinking: string | null;
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
  // Queue actions
  | { type: 'QUEUE_MESSAGE'; payload: QueuedMessage }
  | { type: 'DEQUEUE_MESSAGE' }
  | { type: 'REMOVE_QUEUED_MESSAGE'; payload: { id: string } }
  | { type: 'SET_QUEUE'; payload: QueuedMessage[] }
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

export function createInitialChatState(overrides?: Partial<ChatState>): ChatState {
  return {
    messages: [],
    running: false,
    stopping: false,
    gitBranch: null,
    availableSessions: [],
    pendingPermission: null,
    pendingQuestion: null,
    loadingSession: false,
    startingSession: false,
    chatSettings: DEFAULT_CHAT_SETTINGS,
    queuedMessages: [],
    toolUseIdToIndex: new Map(),
    latestThinking: null,
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
  // Always clear starting state when receiving a Claude message
  let baseState: ChatState = { ...state, startingSession: false };

  // Set running to false when we receive a result
  if (claudeMsg.type === 'result') {
    baseState = { ...baseState, running: false };
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

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    // WebSocket status messages
    case 'WS_STATUS':
      return { ...state, running: action.payload.running };
    case 'WS_STARTING':
      return { ...state, startingSession: true };
    case 'WS_STARTED':
      return { ...state, startingSession: false, running: true, latestThinking: null };
    case 'WS_STOPPED':
      return { ...state, running: false, stopping: false, startingSession: false };

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
      let pendingPermission: PermissionRequest | null = state.pendingPermission;
      let pendingQuestion: UserQuestionRequest | null = state.pendingQuestion;

      if (pendingReq) {
        if (pendingReq.toolName === 'AskUserQuestion') {
          // Restore AskUserQuestion modal
          const input = pendingReq.input as { questions?: unknown[] };
          pendingQuestion = {
            requestId: pendingReq.requestId,
            questions: (input.questions ?? []) as UserQuestionRequest['questions'],
            timestamp: pendingReq.timestamp,
          };
        } else {
          // Restore permission request (ExitPlanMode or other)
          pendingPermission = {
            requestId: pendingReq.requestId,
            toolName: pendingReq.toolName,
            toolInput: pendingReq.input,
            timestamp: pendingReq.timestamp,
            planContent: pendingReq.planContent,
          };
        }
      }

      return {
        ...state,
        messages,
        gitBranch: action.payload.gitBranch,
        running: action.payload.running,
        loadingSession: false,
        toolUseIdToIndex: new Map(),
        pendingPermission,
        pendingQuestion,
      };
    }

    // Permission and question requests
    case 'WS_PERMISSION_REQUEST':
      return { ...state, pendingPermission: action.payload };
    case 'WS_USER_QUESTION':
      return { ...state, pendingQuestion: action.payload };
    case 'PERMISSION_RESPONSE': {
      // If ExitPlanMode was approved, disable plan mode in settings
      const shouldDisablePlanMode =
        action.payload.allow && state.pendingPermission?.toolName === 'ExitPlanMode';
      return {
        ...state,
        pendingPermission: null,
        ...(shouldDisablePlanMode && {
          chatSettings: { ...state.chatSettings, planModeEnabled: false },
        }),
      };
    }
    case 'QUESTION_RESPONSE':
      return { ...state, pendingQuestion: null };

    // Session switching
    case 'SESSION_SWITCH_START':
      return {
        ...state,
        messages: [],
        gitBranch: null,
        pendingPermission: null,
        pendingQuestion: null,
        startingSession: false,
        loadingSession: true,
        running: false,
        queuedMessages: [],
        toolUseIdToIndex: new Map(),
        latestThinking: null,
      };
    case 'SESSION_LOADING_START':
      return { ...state, loadingSession: true };

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
      return { ...state, stopping: true };

    // User messages
    case 'USER_MESSAGE_SENT':
      return { ...state, messages: [...state.messages, action.payload] };

    // Queue management
    case 'QUEUE_MESSAGE':
      return { ...state, queuedMessages: [...state.queuedMessages, action.payload] };
    case 'DEQUEUE_MESSAGE':
      return { ...state, queuedMessages: state.queuedMessages.slice(1) };
    case 'REMOVE_QUEUED_MESSAGE':
      return {
        ...state,
        queuedMessages: state.queuedMessages.filter((msg) => msg.id !== action.payload.id),
      };
    case 'SET_QUEUE':
      return { ...state, queuedMessages: action.payload };

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
    case 'CLEAR_CHAT':
      return {
        ...state,
        messages: [],
        gitBranch: null,
        pendingPermission: null,
        pendingQuestion: null,
        startingSession: false,
        stopping: false,
        chatSettings: DEFAULT_CHAT_SETTINGS,
        toolUseIdToIndex: new Map(),
        latestThinking: null,
      };
    case 'RESET_FOR_SESSION_SWITCH':
      return {
        ...state,
        messages: [],
        gitBranch: null,
        pendingPermission: null,
        pendingQuestion: null,
        startingSession: false,
        loadingSession: true,
        running: false,
        queuedMessages: [],
        toolUseIdToIndex: new Map(),
        latestThinking: null,
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
    case 'message_queued':
      return null; // Acknowledgment - no state change needed
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

/**
 * Creates a queue message action.
 */
export function createQueueMessageAction(text: string): ChatAction {
  const queuedMsg: QueuedMessage = {
    id: generateMessageId(),
    text: text.trim(),
    timestamp: new Date().toISOString(),
  };
  return { type: 'QUEUE_MESSAGE', payload: queuedMsg };
}
