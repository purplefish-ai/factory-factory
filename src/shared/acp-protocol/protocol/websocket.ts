import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import type { AgentMetadata } from './agent';
import type { PluginInfo, ToolDefinition } from './content';
import type { AskUserQuestion } from './interaction';
import type { ChatMessage } from './messages';
import type { ChatSettings, CommandInfo } from './models';
import type { MessageAttachment, QueuedMessage } from './queued';
import type { SessionInfo } from './session';
import type { MessageState } from './state-machine';

interface WebSocketMessageCommon {
  sessionId?: string;
  dbSessionId?: string;
  message?: string;
  code?: number;
  data?: unknown;
  sessions?: SessionInfo[];
  agentMetadata?: AgentMetadata;
  requestId?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  planContent?: string | null;
  questions?: AskUserQuestion[];
  acpOptions?: Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
  text?: string;
  id?: string;
  order?: number;
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
  };
  tool_use_id?: string;
  tool_name?: string;
  parent_tool_use_id?: string;
  elapsed_time_seconds?: number;
  summary?: string;
  preceding_tool_use_ids?: string[];
  permissionMode?: string;
  slashCommands?: CommandInfo[];
  uuid?: string;
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
    pendingInteractiveRequest?: PendingInteractiveRequest | null;
    loadRequestId?: string;
  };
  session_delta: {
    data: SessionDeltaEvent;
  };
  session_runtime_snapshot: {
    sessionRuntime: SessionRuntimeState;
  };
  session_runtime_updated: {
    sessionRuntime: SessionRuntimeState;
  };
  agent_message: {
    data: import('./messages').AgentMessage;
    /** Backend-assigned order for agent_message and message_used_as_response events */
    order?: number;
  };
  error: {
    message: string;
    code?: number;
  };
  sessions: {
    sessions: SessionInfo[];
  };
  agent_metadata: {
    agentMetadata: AgentMetadata;
  };
  permission_request: {
    requestId?: string;
    toolName?: string;
    toolUseId?: string;
    toolInput?: Record<string, unknown>;
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
  message_used_as_response: {
    text?: string;
    id?: string;
    order?: number;
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
    };
  };
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
  tool_use_summary: {
    summary?: string;
    preceding_tool_use_ids?: string[];
  };
  status_update: {
    permissionMode?: string;
  };
  task_notification: {
    message?: string;
  };
  system_init: {
    data?: {
      tools?: ToolDefinition[];
      model?: string;
      cwd?: string;
      apiKeySource?: string;
      slashCommands?: CommandInfo[];
      plugins?: PluginInfo[];
    };
  };
  compact_boundary: object;
  hook_started: {
    data?: {
      hookId?: string;
      hookName?: string;
      hookEvent?: string;
    };
  };
  hook_response: {
    data?: {
      hookId?: string;
      output?: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      outcome?: string;
    };
  };
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
  user_message_uuid: {
    uuid?: string;
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
      currentValue: string;
      options: unknown[];
    }>;
  };
}

/**
 * WebSocket message envelope types for the chat/agent-activity WebSocket protocol.
 */
type WebSocketMessageType = keyof WebSocketMessagePayloadByType;
export const SESSION_DELTA_EXCLUDED_MESSAGE_TYPES = [
  'session_delta',
  'session_snapshot',
  'session_replay_batch',
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
  session_runtime_snapshot: true,
  session_runtime_updated: true,
  agent_message: true,
  error: true,
  sessions: true,
  agent_metadata: true,
  permission_request: true,
  user_question: true,
  permission_cancelled: true,
  message_used_as_response: true,
  message_state_changed: true,
  session_replay_batch: true,
  tool_progress: true,
  tool_use_summary: true,
  status_update: true,
  task_notification: true,
  system_init: true,
  compact_boundary: true,
  hook_started: true,
  hook_response: true,
  compacting_start: true,
  compacting_end: true,
  workspace_notification_request: true,
  slash_commands: true,
  user_message_uuid: true,
  chat_capabilities: true,
  config_options_update: true,
};

export const WEBSOCKET_MESSAGE_TYPES = Object.keys(
  WEBSOCKET_MESSAGE_TYPE_MAP
) as WebSocketMessage['type'][];
