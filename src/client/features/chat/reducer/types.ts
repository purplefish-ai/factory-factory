import type { AcpConfigOption } from '@/client/lib/acp-config';
export type {
  AcpConfigOption,
  AcpConfigOptionValue,
  AcpConfigOptionGroup,
} from '@/client/lib/acp-config';
import type {
  AgentMessage,
  ChatMessage,
  ChatSettings,
  CommandInfo,
  MessageAttachment,
  MessageState,
  PendingInteractiveRequest,
  PermissionRequest,
  QueuedMessage,
  SessionRuntimeState,
  TokenStats,
  SessionDeltaEvent,
  UserQuestionRequest,
} from '@/lib/chat-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';

// =============================================================================
// State Types
// =============================================================================

/** Information about a rejected message for recovery */
export interface RejectedMessageInfo {
  text: string;
  attachments?: MessageAttachment[];
  error: string;
  sessionId?: string | null;
}

/** Content stored for a pending message (for recovery on rejection) */
export interface PendingMessageContent {
  text: string;
  attachments?: MessageAttachment[];
  sessionId?: string | null;
}

/** Queued message metadata tracked locally for rejection recovery. */
export interface RecoverableQueuedMessage extends QueuedMessage {
  sessionId?: string | null;
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

export interface ProcessStatus {
  state: 'unknown' | 'alive' | 'stopped';
  lastExit?: {
    code: number | null;
    exitedAt: string;
    unexpected: boolean;
  };
}

/** ACP tool call location for click-to-open */
export interface AcpToolLocation {
  path: string;
  line?: number | null;
}

/** Individual entry in an ACP plan */
export interface AcpPlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

/** ACP plan state -- latest full plan from agent */
export interface AcpPlanState {
  entries: AcpPlanEntry[];
  updatedAt: string;
}

/** Tool progress tracking for long-running tool executions */
export interface ToolProgressInfo {
  toolName: string;
  elapsedSeconds: number;
  /** ACP tool call file locations for click-to-open rendering */
  acpLocations?: AcpToolLocation[];
  /** ACP tool kind (read, edit, execute, etc.) */
  acpKind?: string;
}

/** Task notification from SDK (e.g., Task tool subagent updates) */
export interface TaskNotification {
  id: string;
  message: string;
  timestamp: string;
}

export type TranscriptHistoryState =
  | { status: 'idle' | 'complete' }
  | {
      status: 'loading';
      requestId: string;
      previousLimit?: number | null;
      previousBoundaries: ReadonlySet<string>;
      removedMessageIds?: ReadonlySet<string>;
    }
  | { status: 'error'; error: string };

export interface ChatState {
  /** Chat messages in the conversation */
  messages: ChatMessage[];
  transcriptHistory: TranscriptHistoryState;
  transcriptPageBoundaries: ReadonlySet<string>;
  /** Override the live renderer window; null keeps provider history uncapped. */
  rendererTranscriptLimit?: number | null;
  /**
   * Session lifecycle status - a discriminated union that makes invalid states unrepresentable.
   * Replaces separate running, stopping, loadingSession, and startingSession booleans.
   */
  sessionStatus: SessionStatus;
  /** Claude process lifecycle status (alive vs stopped) */
  processStatus: ProcessStatus;
  /** Authoritative runtime snapshot for this session. */
  sessionRuntime: SessionRuntimeState;
  /** Current git branch for the session */
  gitBranch: string | null;
  /**
   * Pending interactive request awaiting user response.
   * Discriminated union ensures only one request type can be active at a time.
   */
  pendingRequest: PendingRequest;
  /** Chat settings (model, thinking, plan mode) */
  chatSettings: ChatSettings;
  /** Provider-owned capabilities for chat bar controls. */
  chatCapabilities: ChatBarCapabilities;
  /** Whether capabilities were received, including a confirmed unsupported payload. */
  chatCapabilitiesLoaded: boolean;
  /** Restored/bootstrap models yield to the first confirmed session model. */
  modelSelectionSource: 'bootstrap' | 'local' | 'server';
  /** Latest model command; failures from superseded requests cannot clear it. */
  pendingModelRequestId: string | null;
  /**
   * Queued messages waiting to be sent.
   * Map from message ID to QueuedMessage - enforces uniqueness by design.
   * Maps automatically de-dupe: adding the same ID twice simply overwrites.
   */
  queuedMessages: Map<string, RecoverableQueuedMessage>;
  /** Tool use ID to message index map for O(1) updates */
  toolUseIdToIndex: Map<string, number>;
  /** Agent transcript order to message index map for O(1) live updates. */
  agentMessageOrderToIndex: Map<number, number>;
  /** Accumulated thinking for the current sequence; text/tool starts clear it. */
  latestThinking: string | null;
  /** Last thinking-affecting agent order, retained independently of transcript trimming. */
  latestThinkingOrder: number | null;
  /** Last accepted thinking delta; a block start may share its first delta's order. */
  latestThinkingDeltaOrder: number | null;
  /**
   * Pending messages awaiting backend confirmation (shown with "sending..." indicator).
   * Map from message ID to content. Presence in map = pending, content = for recovery on rejection.
   * Replaces separate pendingMessageIds Set and pendingMessageContent Map.
   */
  pendingMessages: Map<string, PendingMessageContent>;
  /** Last rejected message for recovery (allows restoring to input) */
  lastRejectedMessage: RejectedMessageInfo | null;
  /** Whether context compaction is in progress */
  isCompacting: boolean;
  /** Tool progress tracking for long-running tools - Map from tool_use_id to progress info */
  toolProgress: Map<string, ToolProgressInfo>;
  /** Whether a compact boundary has been encountered in this session */
  hasCompactBoundary: boolean;
  /** Task notifications from SDK (e.g., subagent updates) */
  taskNotifications: TaskNotification[];
  /** Slash commands from CLI initialize response */
  slashCommands: CommandInfo[];
  /** Whether slash commands have finished loading for this session */
  slashCommandsLoaded: boolean;
  /** Accumulated token usage stats for the session */
  tokenStats: TokenStats;
  /** Result orders included in tokenStats, independent of renderer retention. */
  countedResultOrders: Set<number>;
  /** ACP agent plan -- latest plan state from ACP plan session updates */
  acpPlan: AcpPlanState | null;
  /** ACP agent-provided config options (model, mode, thought level, custom) */
  acpConfigOptions: AcpConfigOption[] | null;
  pendingConfigOptions: Map<string, { value: string; requestId: string }>;
  needsConfigReconciliation: boolean;
}

// =============================================================================
// Action Types
// =============================================================================

export type ChatAction =
  | { type: 'TRANSCRIPT_HISTORY_START'; requestId: string; beforeMessageId: string }
  | {
      type: 'TRANSCRIPT_HISTORY_LOADED';
      requestId: string;
      messages: ChatMessage[];
      hasMore: boolean;
    }
  | { type: 'TRANSCRIPT_HISTORY_FAILED'; requestId: string; error: string }
  // WebSocket message actions
  | { type: 'SESSION_RUNTIME_SNAPSHOT'; payload: { sessionRuntime: SessionRuntimeState } }
  | { type: 'SESSION_RUNTIME_UPDATED'; payload: { sessionRuntime: SessionRuntimeState } }
  | {
      type: 'WS_AGENT_MESSAGE';
      payload: { message: AgentMessage; order: number; messageId?: string };
    }
  | {
      type: 'WS_ASSISTANT_TEXT_DELTA';
      payload: { messageId: string; order: number; offset: number; text: string };
    }
  | { type: 'WS_ERROR'; payload: { message: string; requestId?: string } }
  | { type: 'WS_PERMISSION_REQUEST'; payload: PermissionRequest }
  | { type: 'WS_USER_QUESTION'; payload: UserQuestionRequest }
  | { type: 'WS_PERMISSION_CANCELLED'; payload: { requestId: string } }
  | { type: 'WS_CHAT_CAPABILITIES'; payload: { capabilities: ChatBarCapabilities } }
  // Session actions
  | { type: 'SESSION_SWITCH_START' }
  | { type: 'SESSION_LOADING_START' }
  | { type: 'SESSION_LOADING_END' }
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
      payload: {
        id: string;
        text: string;
        attachments?: MessageAttachment[];
        sessionId?: string | null;
      };
    }
  | { type: 'CLEAR_REJECTED_MESSAGE' }
  // Settings action
  | { type: 'UPDATE_SETTINGS'; payload: Partial<ChatSettings>; requestId?: string }
  | { type: 'SET_SETTINGS'; payload: ChatSettings }
  // Clear/reset actions
  | { type: 'CLEAR_CHAT' }
  | { type: 'RESET_FOR_SESSION_SWITCH' }
  // Message state machine actions (primary protocol)
  | {
      type: 'SESSION_SNAPSHOT';
      payload: {
        messages: ChatMessage[];
        isHydration?: boolean;
        removedMessageIds?: string[];
        queuedMessages: QueuedMessage[];
        sessionRuntime: SessionRuntimeState;
        acpPlan?: AcpPlanState | null;
        pendingInteractiveRequest?: PendingInteractiveRequest | null;
      };
    }
  // Targeted session-state deltas (replace snapshots for queue/commit/request changes)
  | { type: 'QUEUE_UPDATED'; payload: { queuedMessages: QueuedMessage[] } }
  | {
      type: 'TRANSCRIPT_MESSAGE_COMMITTED';
      payload: { message: ChatMessage; queuedMessages: QueuedMessage[] };
    }
  | {
      type: 'PENDING_REQUEST_UPDATED';
      payload: { pendingInteractiveRequest: PendingInteractiveRequest | null };
    }
  | {
      type: 'SESSION_REPLAY_BATCH';
      payload: {
        replayEvents: SessionDeltaEvent[];
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
          settings?: QueuedMessage['settings'];
          /** Backend-assigned order for reliable sorting. Undefined for ACCEPTED, defined for DISPATCHED. */
          order?: number;
          /** Source session for restoring a failed message to the correct composer. */
          sessionId?: string;
        };
      };
    }
  // SDK message type actions
  | {
      type: 'SDK_TOOL_PROGRESS';
      payload: {
        toolUseId: string;
        toolName: string;
        elapsedSeconds: number;
        acpLocations?: AcpToolLocation[];
        acpKind?: string;
      };
    }
  | { type: 'SDK_TASK_NOTIFICATION'; payload: { message: string } }
  | { type: 'SDK_COMPACTING_START' }
  | { type: 'SDK_COMPACTING_END' }
  // System subtype actions
  | { type: 'COMPACT_BOUNDARY' }
  // Task notification management
  | { type: 'DISMISS_TASK_NOTIFICATION'; payload: { id: string } }
  | { type: 'CLEAR_TASK_NOTIFICATIONS' }
  // Slash commands discovery
  | { type: 'WS_SLASH_COMMANDS'; payload: { commands: CommandInfo[] } }
  // ACP plan updates
  | { type: 'ACP_PLAN_UPDATE'; payload: { entries: AcpPlanEntry[] } }
  // ACP config options update
  | { type: 'CONFIG_OPTIONS_UPDATE'; payload: { configOptions: AcpConfigOption[] } }
  | {
      type: 'CONFIG_OPTION_REQUESTED';
      payload: { configId: string; value: string; requestId: string };
    }
  | { type: 'CONFIG_OPTION_APPLIED'; payload: { requestId: string } }
  | { type: 'CONFIG_OPTIONS_DISCONNECTED' };
