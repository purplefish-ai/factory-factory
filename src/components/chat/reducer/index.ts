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
  // If userMessage exists, order is required
  const userMessage =
    data.userMessage && data.userMessage.order !== undefined
      ? { ...data.userMessage, order: data.userMessage.order }
      : undefined;
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

/**
 * Creates a ChatAction from a WebSocketMessage.
 * Returns null if the message type is not handled.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: switch statement complexity is inherent to message type dispatch
export function createActionFromWebSocketMessage(data: WebSocketMessage): ChatAction | null {
  switch (data.type) {
    case 'status':
      return handleStatusMessage(data);
    case 'starting':
      return { type: 'WS_STARTING' };
    case 'started':
      return { type: 'WS_STARTED' };
    case 'stopped':
      return { type: 'WS_STOPPED' };
    case 'process_exit':
      return { type: 'WS_PROCESS_EXIT', payload: { code: data.code ?? null } };
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
    // Request cancelled by CLI (e.g., Ctrl+C during permission or question prompt)
    case 'permission_cancelled':
      if (!data.requestId) {
        // biome-ignore lint/suspicious/noConsole: Error logging for debugging malformed WebSocket messages
        console.error('[Chat Reducer] Received permission_cancelled without requestId', data);
      }
      return { type: 'WS_PERMISSION_CANCELLED', payload: { requestId: data.requestId ?? '' } };
    // Interactive response handling
    case 'message_used_as_response':
      return data.id && data.text && data.order !== undefined
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
      return {
        type: 'SDK_STATUS_UPDATE',
        payload: { permissionMode: data.permissionMode },
      };
    case 'task_notification':
      return data.message
        ? { type: 'SDK_TASK_NOTIFICATION', payload: { message: data.message } }
        : null;
    // System subtype events
    case 'system_init':
      return handleSystemInitMessage(data);
    case 'compact_boundary':
      return { type: 'COMPACT_BOUNDARY' };
    case 'hook_started':
      return handleHookStartedMessage(data);
    case 'hook_response':
      return handleHookResponseMessage(data);
    // Context compaction events
    case 'compacting_start':
      return { type: 'SDK_COMPACTING_START' };
    case 'compacting_end':
      return { type: 'SDK_COMPACTING_END' };
    // Slash commands discovery
    case 'slash_commands':
      return data.slashCommands
        ? { type: 'WS_SLASH_COMMANDS', payload: { commands: data.slashCommands } }
        : null;
    // User message UUID tracking (for rewind functionality)
    case 'user_message_uuid':
      return data.uuid
        ? { type: 'USER_MESSAGE_UUID_RECEIVED', payload: { uuid: data.uuid } }
        : null;
    // Rewind files response events
    case 'rewind_files_preview':
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
    case 'rewind_files_error':
      return data.rewindError
        ? {
            type: 'REWIND_PREVIEW_ERROR',
            payload: { error: data.rewindError, userMessageId: data.userMessageId },
          }
        : null;
    default:
      return null;
  }
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
