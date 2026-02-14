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

import type { ChatMessage, PermissionRequest, WebSocketMessage } from '@/lib/chat-protocol';
import { isWebSocketMessage, isWsAgentMessage } from '@/lib/chat-protocol';
import { generateMessageId } from './helpers';
import { reduceMessageCompactSlice } from './slices/messages/compact';
import { reduceMessageQueueSlice } from './slices/messages/queue';
import { reduceMessageResetSlice } from './slices/messages/reset';
import { reduceMessageSnapshotSlice } from './slices/messages/snapshot';
import { reduceMessageStateMachineSlice } from './slices/messages/state-machine';
import { reduceMessageTransportSlice } from './slices/messages/transport';
import { reduceMessageUuidSlice } from './slices/messages/uuid';
import { reduceRequestSlice } from './slices/requests';
import { reduceRewindExecutionSlice, reduceRewindPreviewSlice } from './slices/rewind';
import { reduceSessionSlice } from './slices/session';
import { reduceSettingsSlice } from './slices/settings';
import { reduceSystemSlice } from './slices/system';
import { reduceToolingSlice } from './slices/tooling';
import { createBaseResetState, createInitialChatState } from './state';
import type { AcpToolLocation, ChatAction, ChatState } from './types';

export { createInitialChatState };
export type {
  AcpConfigOption,
  AcpConfigOptionGroup,
  AcpConfigOptionValue,
  AcpPlanEntry,
  AcpPlanState,
  AcpToolLocation,
  ChatAction,
  ChatState,
  PendingMessageContent,
  PendingRequest,
  ProcessStatus,
  RejectedMessageInfo,
  RewindPreviewState,
  SessionStatus,
  TaskNotification,
  ToolProgressInfo,
} from './types';

// =============================================================================
// Reducer Slices
// =============================================================================

type ReducerSlice = (state: ChatState, action: ChatAction) => ChatState;

// =============================================================================
// Reducer
// =============================================================================

const chatReducerSlices: ReducerSlice[] = [
  reduceSessionSlice,
  reduceRequestSlice,
  reduceSettingsSlice,
  reduceMessageTransportSlice,
  reduceMessageQueueSlice,
  reduceMessageResetSlice,
  reduceMessageSnapshotSlice,
  reduceMessageStateMachineSlice,
  reduceMessageUuidSlice,
  reduceMessageCompactSlice,
  reduceToolingSlice,
  reduceSystemSlice,
  reduceRewindPreviewSlice,
  reduceRewindExecutionSlice,
];

function reduceSingleAction(currentState: ChatState, currentAction: ChatAction): ChatState {
  let nextState = currentState;
  for (const reduce of chatReducerSlices) {
    const updated = reduce(nextState, currentAction);
    if (updated !== nextState) {
      nextState = updated;
    }
  }
  return nextState;
}

function createReplayBaseState(state: ChatState): ChatState {
  return {
    ...state,
    ...createBaseResetState(),
    // Preserve optimistic pending sends that are not yet reflected in replayed events.
    pendingMessages: state.pendingMessages,
    // Preserve queued messages - they will be reconstructed from replay events,
    // but preserving them ensures they remain visible during replay processing.
    queuedMessages: state.queuedMessages,
    sessionStatus: { phase: 'loading' },
    processStatus: { state: 'unknown' },
    sessionRuntime: {
      ...state.sessionRuntime,
      phase: 'loading',
      processState: 'unknown',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    },
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === 'SESSION_REPLAY_BATCH') {
    let nextState = createReplayBaseState(state);
    for (const event of action.payload.replayEvents) {
      if (event.type === 'session_replay_batch') {
        continue;
      }
      const replayAction = createActionFromWebSocketMessage(event);
      if (!replayAction || replayAction.type === 'SESSION_REPLAY_BATCH') {
        continue;
      }
      nextState = reduceSingleAction(nextState, replayAction);
    }
    // Clear loading state after replay completes
    // Only clear if still in loading phase (runtime updates during replay may have already changed it)
    if (nextState.sessionStatus.phase === 'loading') {
      nextState = reduceSingleAction(nextState, { type: 'SESSION_LOADING_END' });
    }
    return nextState;
  }

  return reduceSingleAction(state, action);
}

// =============================================================================
// Action Creators (for type-safe dispatch)
// =============================================================================

// Individual message type handlers for createActionFromWebSocketMessage

function handleSessionRuntimeSnapshotMessage(data: WebSocketMessage): ChatAction | null {
  if (!data.sessionRuntime) {
    return null;
  }
  return {
    type: 'SESSION_RUNTIME_SNAPSHOT',
    payload: { sessionRuntime: data.sessionRuntime },
  };
}

function handleSessionRuntimeUpdatedMessage(data: WebSocketMessage): ChatAction | null {
  if (!data.sessionRuntime) {
    return null;
  }
  return {
    type: 'SESSION_RUNTIME_UPDATED',
    payload: { sessionRuntime: data.sessionRuntime },
  };
}

function handleClaudeMessageAction(data: WebSocketMessage): ChatAction | null {
  if (isWsAgentMessage(data) && data.order !== undefined) {
    return { type: 'WS_AGENT_MESSAGE', payload: { message: data.data, order: data.order } };
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

function handleChatCapabilitiesMessage(data: WebSocketMessage): ChatAction | null {
  if (!data.capabilities) {
    return null;
  }
  return {
    type: 'WS_CHAT_CAPABILITIES',
    payload: { capabilities: data.capabilities },
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
        // Include ACP permission options for multi-option UI
        acpOptions: (data as Record<string, unknown>).acpOptions as
          | PermissionRequest['acpOptions']
          | undefined,
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

function handleSessionSnapshot(data: WebSocketMessage): ChatAction | null {
  if (!(data.messages && data.queuedMessages && data.sessionRuntime)) {
    return null;
  }
  return {
    type: 'SESSION_SNAPSHOT',
    payload: {
      messages: data.messages,
      queuedMessages: data.queuedMessages,
      sessionRuntime: data.sessionRuntime,
      pendingInteractiveRequest: data.pendingInteractiveRequest ?? null,
    },
  };
}

function handleSessionReplayBatch(data: WebSocketMessage): ChatAction | null {
  if (!Array.isArray(data.replayEvents)) {
    return null;
  }
  return {
    type: 'SESSION_REPLAY_BATCH',
    payload: {
      replayEvents: data.replayEvents.filter(isWebSocketMessage),
    },
  };
}

function handleMessageStateChanged(data: WebSocketMessage): ChatAction | null {
  if (!(data.id && data.newState)) {
    return null;
  }
  // Pass userMessage as-is; order may be undefined for ACCEPTED messages
  const userMessage = data.userMessage ? { ...data.userMessage } : undefined;
  return {
    type: 'MESSAGE_STATE_CHANGED',
    payload: {
      id: data.id,
      newState: data.newState,
      queuePosition: data.queuePosition,
      errorMessage: data.errorMessage,
      userMessage,
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
      // Pass through ACP-specific fields from tool_progress WebSocket messages
      acpLocations: (data as Record<string, unknown>).acpLocations as AcpToolLocation[] | undefined,
      acpKind: (data as Record<string, unknown>).acpKind as string | undefined,
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

function handleSystemInitMessage(data: WebSocketMessage): ChatAction | null {
  const initData = data.data as
    | {
        tools?: Array<{
          name: string;
          description?: string;
          input_schema?: Record<string, unknown>;
        }>;
        model?: string;
        cwd?: string;
        apiKeySource?: string;
        slashCommands?: string[];
        plugins?: Array<{ name: string; path: string }>;
      }
    | undefined;
  if (!initData) {
    return null;
  }
  return {
    type: 'SYSTEM_INIT',
    payload: {
      tools: initData.tools ?? [],
      model: initData.model ?? null,
      cwd: initData.cwd ?? null,
      apiKeySource: initData.apiKeySource ?? null,
      slashCommands: initData.slashCommands ?? [],
      plugins: initData.plugins ?? [],
    },
  };
}

function handleHookStartedMessage(data: WebSocketMessage): ChatAction | null {
  const hookData = data.data as
    | {
        hookId?: string;
        hookName?: string;
        hookEvent?: string;
      }
    | undefined;
  if (!(hookData?.hookId && hookData?.hookName && hookData?.hookEvent)) {
    return null;
  }
  return {
    type: 'HOOK_STARTED',
    payload: {
      hookId: hookData.hookId,
      hookName: hookData.hookName,
      hookEvent: hookData.hookEvent,
    },
  };
}

function handleHookResponseMessage(data: WebSocketMessage): ChatAction | null {
  const hookRespData = data.data as { hookId?: string } | undefined;
  if (!hookRespData?.hookId) {
    return null;
  }
  return { type: 'HOOK_RESPONSE', payload: { hookId: hookRespData.hookId } };
}

function handlePermissionCancelledMessage(data: WebSocketMessage): ChatAction | null {
  if (!data.requestId) {
    return null;
  }
  return { type: 'WS_PERMISSION_CANCELLED', payload: { requestId: data.requestId } };
}

function handleMessageUsedAsResponseMessage(data: WebSocketMessage): ChatAction | null {
  if (!(data.id && data.text && data.order !== undefined)) {
    return null;
  }
  return {
    type: 'MESSAGE_USED_AS_RESPONSE',
    payload: { id: data.id, text: data.text, order: data.order },
  };
}

function handleStatusUpdateMessage(data: WebSocketMessage): ChatAction {
  return {
    type: 'SDK_STATUS_UPDATE',
    payload: { permissionMode: data.permissionMode },
  };
}

function handleTaskNotificationMessage(data: WebSocketMessage): ChatAction | null {
  if (!data.message) {
    return null;
  }
  // Check if this is an ACP plan update (JSON message with type 'acp_plan')
  try {
    const parsed = JSON.parse(data.message);
    if (parsed && parsed.type === 'acp_plan' && Array.isArray(parsed.entries)) {
      return {
        type: 'ACP_PLAN_UPDATE',
        payload: { entries: parsed.entries },
      };
    }
  } catch {
    // Not JSON, treat as regular task notification
  }
  return { type: 'SDK_TASK_NOTIFICATION', payload: { message: data.message } };
}

function handleSlashCommandsMessage(data: WebSocketMessage): ChatAction | null {
  return data.slashCommands
    ? { type: 'WS_SLASH_COMMANDS', payload: { commands: data.slashCommands } }
    : null;
}

function handleUserMessageUuidMessage(data: WebSocketMessage): ChatAction | null {
  return data.uuid ? { type: 'USER_MESSAGE_UUID_RECEIVED', payload: { uuid: data.uuid } } : null;
}

function handleConfigOptionsUpdateMessage(data: WebSocketMessage): ChatAction | null {
  const configOptions = (data as Record<string, unknown>).configOptions;
  if (!Array.isArray(configOptions)) {
    return null;
  }
  return {
    type: 'CONFIG_OPTIONS_UPDATE',
    payload: { configOptions },
  };
}

// Handler map for WebSocket message types
type MessageHandler = (data: WebSocketMessage) => ChatAction | null;

type MessageHandlerMap = {
  [K in WebSocketMessage['type']]: MessageHandler | null;
};

const messageHandlers: MessageHandlerMap = {
  session_runtime_snapshot: handleSessionRuntimeSnapshotMessage,
  session_runtime_updated: handleSessionRuntimeUpdatedMessage,
  agent_message: handleClaudeMessageAction,
  error: handleErrorMessageAction,
  sessions: handleSessionsMessage,
  chat_capabilities: handleChatCapabilitiesMessage,
  agent_metadata: null,
  permission_request: handlePermissionRequestMessage,
  user_question: handleUserQuestionMessage,
  permission_cancelled: handlePermissionCancelledMessage,
  message_used_as_response: handleMessageUsedAsResponseMessage,
  session_snapshot: handleSessionSnapshot,
  session_delta: null,
  session_replay_batch: handleSessionReplayBatch,
  message_state_changed: handleMessageStateChanged,
  tool_progress: handleToolProgressMessage,
  tool_use_summary: handleToolUseSummaryMessage,
  status_update: handleStatusUpdateMessage,
  task_notification: handleTaskNotificationMessage,
  system_init: handleSystemInitMessage,
  compact_boundary: () => ({ type: 'COMPACT_BOUNDARY' }),
  hook_started: handleHookStartedMessage,
  hook_response: handleHookResponseMessage,
  compacting_start: () => ({ type: 'SDK_COMPACTING_START' }),
  compacting_end: () => ({ type: 'SDK_COMPACTING_END' }),
  workspace_notification_request: null,
  slash_commands: handleSlashCommandsMessage,
  user_message_uuid: handleUserMessageUuidMessage,
  config_options_update: handleConfigOptionsUpdateMessage,
};

/**
 * Creates a ChatAction from a WebSocketMessage.
 * Returns null if the message type is not handled.
 */
export function createActionFromWebSocketMessage(data: WebSocketMessage): ChatAction | null {
  const handler = messageHandlers[data.type];
  return handler ? handler(data) : null;
}

/**
 * Creates a user message action.
 */
export function createUserMessageAction(text: string, order: number): ChatAction {
  const chatMessage: ChatMessage = {
    id: generateMessageId(),
    source: 'user',
    text,
    timestamp: new Date().toISOString(),
    order,
  };
  return { type: 'USER_MESSAGE_SENT', payload: chatMessage };
}
