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

import type { ChatMessage, WebSocketMessage } from '@/lib/claude-types';
import { isWsClaudeMessage } from '@/lib/claude-types';
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
import { createInitialChatState } from './state';
import type { ChatAction, ChatState } from './types';

export { createInitialChatState };
export type {
  ChatAction,
  ChatState,
  PendingMessageContent,
  PendingRequest,
  ProcessStatus,
  RejectedMessageInfo,
  RewindPreviewState,
  SessionStatus,
  TaskNotification,
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

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  let nextState = state;
  for (const reduce of chatReducerSlices) {
    const updated = reduce(nextState, action);
    if (updated !== nextState) {
      nextState = updated;
    }
  }
  return nextState;
}

// =============================================================================
// Action Creators (for type-safe dispatch)
// =============================================================================

// Individual message type handlers for createActionFromWebSocketMessage

function handleStatusMessage(data: WebSocketMessage): ChatAction {
  return {
    type: 'WS_STATUS',
    payload: { running: data.running ?? false, processAlive: data.processAlive },
  };
}

function handleClaudeMessageAction(data: WebSocketMessage): ChatAction | null {
  if (isWsClaudeMessage(data) && data.order !== undefined) {
    return { type: 'WS_CLAUDE_MESSAGE', payload: { message: data.data, order: data.order } };
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

function handlePermissionCancelledMessage(data: WebSocketMessage): ChatAction {
  if (!data.requestId) {
    // biome-ignore lint/suspicious/noConsole: Error logging for debugging malformed WebSocket messages
    console.error('[Chat Reducer] Received permission_cancelled without requestId', data);
  }
  return { type: 'WS_PERMISSION_CANCELLED', payload: { requestId: data.requestId ?? '' } };
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
  return data.message
    ? { type: 'SDK_TASK_NOTIFICATION', payload: { message: data.message } }
    : null;
}

function handleSlashCommandsMessage(data: WebSocketMessage): ChatAction | null {
  return data.slashCommands
    ? { type: 'WS_SLASH_COMMANDS', payload: { commands: data.slashCommands } }
    : null;
}

function handleUserMessageUuidMessage(data: WebSocketMessage): ChatAction | null {
  return data.uuid ? { type: 'USER_MESSAGE_UUID_RECEIVED', payload: { uuid: data.uuid } } : null;
}

function handleRewindFilesPreviewMessage(data: WebSocketMessage): ChatAction {
  // If dryRun is false, this is the actual rewind completion
  if (data.dryRun === false) {
    return { type: 'REWIND_SUCCESS', payload: { userMessageId: data.userMessageId } };
  }
  // Otherwise, this is a preview (dry run) response
  return {
    type: 'REWIND_PREVIEW_SUCCESS',
    payload: {
      affectedFiles: data.affectedFiles ?? [],
      userMessageId: data.userMessageId,
    },
  };
}

function handleRewindFilesErrorMessage(data: WebSocketMessage): ChatAction | null {
  return data.rewindError
    ? {
        type: 'REWIND_PREVIEW_ERROR',
        payload: { error: data.rewindError, userMessageId: data.userMessageId },
      }
    : null;
}

// Handler map for WebSocket message types
type MessageHandler = (data: WebSocketMessage) => ChatAction | null;

const messageHandlers: Record<string, MessageHandler> = {
  status: handleStatusMessage,
  starting: () => ({ type: 'WS_STARTING' }),
  started: () => ({ type: 'WS_STARTED' }),
  stopped: () => ({ type: 'WS_STOPPED' }),
  process_exit: (data) => ({ type: 'WS_PROCESS_EXIT', payload: { code: data.code ?? null } }),
  claude_message: handleClaudeMessageAction,
  error: handleErrorMessageAction,
  sessions: handleSessionsMessage,
  permission_request: handlePermissionRequestMessage,
  user_question: handleUserQuestionMessage,
  permission_cancelled: handlePermissionCancelledMessage,
  message_used_as_response: handleMessageUsedAsResponseMessage,
  messages_snapshot: handleMessagesSnapshot,
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
  slash_commands: handleSlashCommandsMessage,
  user_message_uuid: handleUserMessageUuidMessage,
  rewind_files_preview: handleRewindFilesPreviewMessage,
  rewind_files_error: handleRewindFilesErrorMessage,
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
