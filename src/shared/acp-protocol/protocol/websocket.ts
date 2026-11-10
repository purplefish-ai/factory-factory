import type { AcpPlanNotification } from '@/shared/acp-protocol/task-plan';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import type { AskUserQuestion } from './interaction';
import type { AgentMessage, ChatMessage } from './messages';
import type { CommandInfo } from './models';
import type { MessageAttachment, QueuedMessage } from './queued';
import type { SessionReplayChunk } from './replay-frame-schema';
import type { MessageState } from './state-machine';

interface ChatConfigOptionValue {
  value: string;
  name: string;
  description?: string | null;
}

/** ACP session configuration option as forwarded to the chat client. */
export interface ChatConfigOption {
  id: string;
  name: string;
  description?: string | null;
  type: string;
  category?: string | null;
  currentValue: string | boolean;
  options?: Array<ChatConfigOptionValue | { group: string; options: ChatConfigOptionValue[] }>;
}

type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

/**
 * Server-to-client payload for each chat WebSocket message type. The client
 * validates these with `ChatServerMessageSchema` (chat-server-message-schema.ts).
 */
interface WebSocketMessagePayloadByType {
  session_snapshot: {
    messages: ChatMessage[];
    queuedMessages: QueuedMessage[];
    sessionRuntime: SessionRuntimeState;
    taskPlan?: AcpPlanNotification | null;
    pendingInteractiveRequest?: PendingInteractiveRequest | null;
    loadRequestId?: string;
    /** Explicit removals also invalidate entries retained before the snapshot window. */
    removedMessageIds?: string[];
    /** Provider identity replacement invalidates the complete retained history. */
    resetTranscript?: boolean;
  };
  session_delta: {
    data: SessionDeltaEvent;
  };
  /** Authoritative queue after a queue-only change; replaces the client's queue. */
  queue_updated: {
    queuedMessages: QueuedMessage[];
  };
  /** Authoritative pending interactive request after it is shown, resolved, or cleared. */
  pending_request_updated: {
    pendingInteractiveRequest: PendingInteractiveRequest | null;
  };
  /** A transcript entry committed from the queue, plus the queue that remains. */
  transcript_message_committed: {
    chatMessage: ChatMessage;
    queuedMessages: QueuedMessage[];
  };
  subagents_changed: {
    sessionId: string;
    subagentId: string;
    change: 'created' | 'updated' | 'completed';
  };
  session_runtime_snapshot: {
    sessionRuntime: SessionRuntimeState;
  };
  session_runtime_updated: {
    sessionRuntime: SessionRuntimeState;
  };
  agent_message: {
    data: AgentMessage;
    /** Stable backend transcript identifier when emitted from snapshot/replay. */
    messageId?: string;
    /**
     * Backend-assigned transcript order. Optional for deltas the backend has not
     * yet published; `ChatServerMessageSchema` requires it on the wire.
     */
    order?: number;
  };
  assistant_text_delta: {
    /** Stable backend transcript identifier for the assistant text block. */
    messageId: string;
    /** Stable backend-assigned transcript order for the assistant text block. */
    order: number;
    /** UTF-16 offset where this text begins in the authoritative message. */
    offset: number;
    /** Newly generated assistant text only. */
    text: string;
  };
  error: {
    message: string;
    code?: number;
    /** Correlates a command failure with the request that caused it. */
    requestId?: string;
    /** Correlates a failed load with its `load_session` request. */
    loadRequestId?: string;
  };
  permission_request: {
    requestId: string;
    toolName: string;
    rawToolName?: string;
    toolUseId?: string;
    toolInput?: Record<string, unknown>;
    elicitation?: 'form' | 'url';
    planContent?: string | null;
    /** ACP permission options -- when present, frontend renders multi-option buttons instead of binary Allow/Deny */
    acpOptions?: AcpPermissionOption[];
  };
  user_question: {
    requestId: string;
    toolName?: string;
    rawToolName?: string;
    questions: AskUserQuestion[];
    /** ACP permission options for mapping selected answer labels to option IDs. */
    acpOptions?: AcpPermissionOption[];
  };
  permission_cancelled: {
    requestId: string;
  };
  message_state_changed: {
    id: string;
    newState: MessageState;
    queuePosition?: number;
    errorMessage?: string;
    userMessage?: {
      text: string;
      timestamp: string;
      attachments?: MessageAttachment[];
      settings?: QueuedMessage['settings'];
      /** Backend-assigned order for reliable sorting */
      order?: number;
      /** Source session for restoring a failed message to the correct composer */
      sessionId?: string;
      /** Set when the original message was sent via voice mode */
      voiceMode?: boolean;
    };
  };
  session_replay_chunk: SessionReplayChunk;
  session_replay_batch: {
    /** Correlates the replay with its `load_session` request. */
    loadRequestId?: string;
    /** Batch of session events for atomic session replay during hydration */
    replayEvents?: SessionDeltaEvent[];
  };
  tool_progress: {
    tool_use_id: string;
    /** Absent when an ACP tool update omits its title. */
    tool_name?: string;
    parent_tool_use_id?: string;
    /** Present on terminal updates; in-progress ACP updates omit it. */
    elapsed_time_seconds?: number;
    /** ACP tool call status; the backend uses it to retire tracked calls. */
    acpStatus?: string;
    /** ACP tool call file locations for click-to-open rendering */
    acpLocations?: Array<{ path: string; line?: number | null }>;
    /** ACP tool kind (read, edit, execute, etc.) */
    acpKind?: string;
  };
  task_notification: {
    message: string;
  };
  compact_boundary: object;
  compacting_start: object;
  compacting_end: object;
  workspace_notification_request: {
    workspaceId?: string;
    workspaceName?: string;
    sessionCount?: number;
    finishedAt?: string;
  };
  slash_commands: {
    slashCommands: CommandInfo[];
  };
  chat_capabilities: {
    capabilities: ChatBarCapabilities;
  };
  config_options_update: {
    configOptions: ChatConfigOption[];
  };
  config_option_applied: { requestId: string };
}

/**
 * WebSocket message envelope types for the chat/agent-activity WebSocket protocol.
 */
type WebSocketMessageType = keyof WebSocketMessagePayloadByType;
/** Envelopes that never travel inside `session_delta` or a replay batch. */
type SessionDeltaExcludedMessageType =
  | 'session_delta'
  | 'session_snapshot'
  | 'session_replay_batch'
  | 'session_replay_chunk';
type SessionDeltaEventType = Exclude<WebSocketMessageType, SessionDeltaExcludedMessageType>;

/**
 * Valid event payload forwarded within session_delta messages.
 */
export type SessionDeltaEvent = {
  [K in SessionDeltaEventType]: { type: K } & WebSocketMessagePayloadByType[K];
}[SessionDeltaEventType];

export type WebSocketMessage = {
  [K in WebSocketMessageType]: { type: K } & WebSocketMessagePayloadByType[K];
}[WebSocketMessageType];
