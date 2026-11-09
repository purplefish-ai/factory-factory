import type { AcpPlanNotification } from '@/shared/acp-protocol/task-plan';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import type { AskUserQuestion } from './interaction';
import type { ChatMessage } from './messages';
import type { ChatSettings, CommandInfo } from './models';
import type { MessageAttachment, QueuedMessage } from './queued';
import type { SessionReplayChunk } from './replay-frame-schema';
import type { MessageState } from './state-machine';

interface WebSocketMessageCommon {
  sessionId?: string;
  dbSessionId?: string;
  message?: string;
  code?: number;
  data?: unknown;
  requestId?: string;
  toolName?: string;
  rawToolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  elicitation?: 'form' | 'url';
  planContent?: string | null;
  questions?: AskUserQuestion[];
  acpOptions?: Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
  text?: string;
  id?: string;
  messageId?: string;
  order?: number;
  offset?: number;
  newState?: MessageState;
  messages?: ChatMessage[];
  sessionRuntime?: SessionRuntimeState;
  pendingInteractiveRequest?: PendingInteractiveRequest | null;
  queuedMessages?: QueuedMessage[];
  loadRequestId?: string;
  replayEvents?: WebSocketMessage[];
  queuePosition?: number;
  errorMessage?: string;
  userMessage?: {
    text: string;
    timestamp: string;
    attachments?: MessageAttachment[];
    settings?: ChatSettings;
    order?: number;
    voiceMode?: boolean;
  };
  tool_use_id?: string;
  tool_name?: string;
  parent_tool_use_id?: string;
  elapsed_time_seconds?: number;
  slashCommands?: CommandInfo[];
  workspaceId?: string;
  workspaceName?: string;
  sessionCount?: number;
  finishedAt?: string;
  capabilities?: ChatBarCapabilities;
}

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
    data: import('./messages').AgentMessage;
    /** Stable backend transcript identifier when emitted from snapshot/replay. */
    messageId?: string;
    /** Backend-assigned transcript order. */
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
  };
  permission_request: {
    requestId?: string;
    toolName?: string;
    rawToolName?: string;
    toolUseId?: string;
    toolInput?: Record<string, unknown>;
    elicitation?: 'form' | 'url';
    planContent?: string | null;
    /** ACP permission options -- when present, frontend renders multi-option buttons instead of binary Allow/Deny */
    acpOptions?: Array<{
      optionId: string;
      name: string;
      kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    }>;
  };
  user_question: {
    requestId?: string;
    toolName?: string;
    rawToolName?: string;
    questions?: AskUserQuestion[];
    /** ACP permission options for mapping selected answer labels to option IDs. */
    acpOptions?: Array<{
      optionId: string;
      name: string;
      kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    }>;
  };
  permission_cancelled: {
    requestId?: string;
  };
  message_state_changed: {
    id?: string;
    newState?: MessageState;
    queuePosition?: number;
    errorMessage?: string;
    userMessage?: {
      text: string;
      timestamp: string;
      attachments?: MessageAttachment[];
      settings?: ChatSettings;
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
    /** Batch of WebSocket events for atomic session replay during hydration */
    replayEvents?: WebSocketMessage[];
  };
  tool_progress: {
    tool_use_id?: string;
    tool_name?: string;
    parent_tool_use_id?: string;
    elapsed_time_seconds?: number;
    /** ACP tool call file locations for click-to-open rendering */
    acpLocations?: Array<{ path: string; line?: number | null }>;
    /** ACP tool kind (read, edit, execute, etc.) */
    acpKind?: string;
  };
  task_notification: {
    message?: string;
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
    slashCommands?: CommandInfo[];
  };
  chat_capabilities: {
    capabilities: ChatBarCapabilities;
  };
  config_options_update: {
    configOptions: Array<{
      id: string;
      name: string;
      description?: string | null;
      type: string;
      category?: string | null;
      currentValue: string | boolean;
      options?: unknown[];
    }>;
  };
  config_option_applied: { requestId: string };
}

/**
 * WebSocket message envelope types for the chat/agent-activity WebSocket protocol.
 */
type WebSocketMessageType = keyof WebSocketMessagePayloadByType;
export const SESSION_DELTA_EXCLUDED_MESSAGE_TYPES = [
  'session_delta',
  'session_snapshot',
  'session_replay_batch',
  'session_replay_chunk',
] as const;
type SessionDeltaExcludedMessageType = (typeof SESSION_DELTA_EXCLUDED_MESSAGE_TYPES)[number];
type SessionDeltaEventType = Exclude<WebSocketMessageType, SessionDeltaExcludedMessageType>;

/**
 * Valid event payload forwarded within session_delta messages.
 */
export type SessionDeltaEvent = {
  [K in SessionDeltaEventType]: WebSocketMessageCommon & {
    type: K;
  } & WebSocketMessagePayloadByType[K];
}[SessionDeltaEventType];

export type WebSocketMessage = {
  [K in keyof WebSocketMessagePayloadByType]: WebSocketMessageCommon & {
    type: K;
  } & WebSocketMessagePayloadByType[K];
}[keyof WebSocketMessagePayloadByType];

/**
 * Canonical list of valid top-level WebSocket message types.
 * Used by runtime type guards to reject malformed/unknown payloads early.
 */
const WEBSOCKET_MESSAGE_TYPE_MAP: Record<WebSocketMessage['type'], true> = {
  session_snapshot: true,
  session_delta: true,
  queue_updated: true,
  pending_request_updated: true,
  transcript_message_committed: true,
  subagents_changed: true,
  session_runtime_snapshot: true,
  session_runtime_updated: true,
  agent_message: true,
  assistant_text_delta: true,
  error: true,
  permission_request: true,
  user_question: true,
  permission_cancelled: true,
  message_state_changed: true,
  session_replay_batch: true,
  session_replay_chunk: true,
  tool_progress: true,
  task_notification: true,
  compact_boundary: true,
  compacting_start: true,
  compacting_end: true,
  workspace_notification_request: true,
  slash_commands: true,
  chat_capabilities: true,
  config_options_update: true,
  config_option_applied: true,
};

export const WEBSOCKET_MESSAGE_TYPES = Object.keys(
  WEBSOCKET_MESSAGE_TYPE_MAP
) as WebSocketMessage['type'][];
