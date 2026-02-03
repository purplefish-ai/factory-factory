import type {
  ActiveHookInfo,
  ChatMessage,
  ChatSettings,
  ClaudeMessage,
  CommandInfo,
  MessageAttachment,
  MessageState,
  PendingInteractiveRequest,
  PermissionRequest,
  QueuedMessage,
  SessionInfo,
  SessionInitData,
  SessionStatus as SharedSessionStatus,
  TokenStats,
  UserQuestionRequest,
} from '@/lib/claude-types';

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

/** Rewind preview state for displaying confirmation dialog */
export interface RewindPreviewState {
  /** User message UUID we're rewinding to */
  userMessageId: string;
  /** Unique identifier for this specific rewind request (for race condition handling) */
  requestNonce: string;
  /** Whether we're currently loading the preview or executing the rewind */
  isLoading: boolean;
  /** Whether the actual rewind is in progress (vs just previewing) */
  isExecuting?: boolean;
  /** Files that would be affected (populated after dry run completes) */
  affectedFiles?: string[];
  /** Error message if preview failed */
  error?: string;
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
  /** Session initialization data (tools, model, etc.) from system init message */
  sessionInitData: SessionInitData | null;
  /** Current permission mode from status updates */
  permissionMode: string | null;
  /** Whether a compact boundary has been encountered in this session */
  hasCompactBoundary: boolean;
  /** Active hooks currently executing - Map from hook_id to hook info */
  activeHooks: Map<string, ActiveHookInfo>;
  /** Task notifications from SDK (e.g., subagent updates) */
  taskNotifications: TaskNotification[];
  /** Slash commands from CLI initialize response */
  slashCommands: CommandInfo[];
  /** Whether slash commands have finished loading for this session */
  slashCommandsLoaded: boolean;
  /** Accumulated token usage stats for the session */
  tokenStats: TokenStats;
  /**
   * Queue of SDK-assigned UUIDs waiting to be mapped to user messages.
   * Used when UUIDs arrive before their corresponding messages.
   */
  pendingUserMessageUuids: string[];
  /**
   * Map from user message ID (stable identifier) to SDK-assigned UUID.
   * Populated as user_message_uuid events are received.
   * Using message IDs instead of indices ensures correct mapping even when
   * messages are inserted or removed from the array.
   */
  messageIdToUuid: Map<string, string>;
  /**
   * Set of user message IDs that were sent in the current session (not loaded from snapshot).
   * Used to ensure UUIDs are only mapped to messages sent in this session,
   * not historical messages from loaded sessions.
   */
  localUserMessageIds: Set<string>;
  /** Current rewind preview state (null when not showing rewind dialog) */
  rewindPreview: RewindPreviewState | null;
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
  | { type: 'WS_CLAUDE_MESSAGE'; payload: { message: ClaudeMessage; order: number } }
  | { type: 'WS_ERROR'; payload: { message: string } }
  | { type: 'WS_SESSIONS'; payload: { sessions: SessionInfo[] } }
  | { type: 'WS_PERMISSION_REQUEST'; payload: PermissionRequest }
  | { type: 'WS_USER_QUESTION'; payload: UserQuestionRequest }
  | { type: 'WS_PERMISSION_CANCELLED'; payload: { requestId: string } }
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
  | { type: 'MESSAGE_USED_AS_RESPONSE'; payload: { id: string; text: string; order: number } }
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
          order: number;
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
  // System subtype actions
  | { type: 'SYSTEM_INIT'; payload: SessionInitData }
  | { type: 'COMPACT_BOUNDARY' }
  | {
      type: 'HOOK_STARTED';
      payload: { hookId: string; hookName: string; hookEvent: string };
    }
  | { type: 'HOOK_RESPONSE'; payload: { hookId: string } }
  // Task notification management
  | { type: 'DISMISS_TASK_NOTIFICATION'; payload: { id: string } }
  | { type: 'CLEAR_TASK_NOTIFICATIONS' }
  // Slash commands discovery
  | { type: 'WS_SLASH_COMMANDS'; payload: { commands: CommandInfo[] } }
  // User message UUID tracking (for rewind functionality)
  | { type: 'USER_MESSAGE_UUID_RECEIVED'; payload: { uuid: string } }
  // Rewind files actions
  | { type: 'REWIND_PREVIEW_START'; payload: { userMessageId: string; requestNonce: string } }
  | { type: 'REWIND_PREVIEW_SUCCESS'; payload: { affectedFiles: string[]; userMessageId?: string } }
  | {
      type: 'REWIND_PREVIEW_ERROR';
      payload: { error: string; userMessageId?: string; requestNonce?: string };
    }
  | { type: 'REWIND_CANCEL' }
  | { type: 'REWIND_EXECUTING' } // Actual rewind in progress
  | { type: 'REWIND_SUCCESS'; payload: { userMessageId?: string } }; // Actual rewind completed
