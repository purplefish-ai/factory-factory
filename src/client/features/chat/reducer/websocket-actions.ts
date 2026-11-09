import type { AcpConfigOption } from '@/client/lib/acp-config';
import type { ChatConfigOption, SessionDeltaEvent, WebSocketMessage } from '@/lib/chat-protocol';
import { parseAcpPlanNotification } from '@/shared/acp-protocol/task-plan';
import type { ChatAction } from './types';

/*
 * Frames reach these creators only after `parseChatServerMessage` validated
 * them, so the creators map fields without re-checking their shape.
 */

type MessageOf<Type extends WebSocketMessage['type']> = Extract<WebSocketMessage, { type: Type }>;

/** Selectable options with a string value; boolean toggles have no chat bar control. */
function toAcpConfigOption(option: ChatConfigOption): AcpConfigOption | null {
  const { currentValue, options, ...rest } = option;
  if (typeof currentValue !== 'string' || !options) {
    return null;
  }
  return { ...rest, currentValue, options };
}

function createSnapshotAction(message: MessageOf<'session_snapshot'>): ChatAction {
  return {
    type: 'SESSION_SNAPSHOT',
    payload: {
      messages: message.messages,
      isHydration: Boolean(message.loadRequestId || message.resetTranscript),
      removedMessageIds: message.removedMessageIds,
      queuedMessages: message.queuedMessages,
      sessionRuntime: message.sessionRuntime,
      pendingInteractiveRequest: message.pendingInteractiveRequest ?? null,
      acpPlan: message.taskPlan
        ? { entries: message.taskPlan.entries, updatedAt: new Date().toISOString() }
        : null,
    },
  };
}

function createPermissionRequestAction(message: MessageOf<'permission_request'>): ChatAction {
  return {
    type: 'WS_PERMISSION_REQUEST',
    payload: {
      requestId: message.requestId,
      toolName: message.toolName,
      ...(message.rawToolName ? { rawToolName: message.rawToolName } : {}),
      toolInput: message.toolInput ?? {},
      ...(message.elicitation ? { elicitation: message.elicitation } : {}),
      timestamp: new Date().toISOString(),
      // Include plan content for ExitPlanMode requests
      planContent: message.planContent ?? null,
      // Include ACP permission options for multi-option UI
      ...(message.acpOptions ? { acpOptions: message.acpOptions } : {}),
    },
  };
}

function createUserQuestionAction(message: MessageOf<'user_question'>): ChatAction {
  return {
    type: 'WS_USER_QUESTION',
    payload: {
      requestId: message.requestId,
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      questions: message.questions,
      ...(message.acpOptions ? { acpOptions: message.acpOptions } : {}),
      timestamp: new Date().toISOString(),
    },
  };
}

function createTaskNotificationAction(message: MessageOf<'task_notification'>): ChatAction {
  const parsed = parseAcpPlanNotification(message.message);
  if (parsed) {
    return { type: 'ACP_PLAN_UPDATE', payload: { entries: parsed.entries } };
  }
  return { type: 'SDK_TASK_NOTIFICATION', payload: { message: message.message } };
}

function createSessionEventAction(event: SessionDeltaEvent): ChatAction | null {
  switch (event.type) {
    case 'session_runtime_snapshot':
      return {
        type: 'SESSION_RUNTIME_SNAPSHOT',
        payload: { sessionRuntime: event.sessionRuntime },
      };
    case 'session_runtime_updated':
      return { type: 'SESSION_RUNTIME_UPDATED', payload: { sessionRuntime: event.sessionRuntime } };
    case 'agent_message':
      // The wire schema requires `order`; only unpublished backend deltas lack it.
      return event.order === undefined
        ? null
        : {
            type: 'WS_AGENT_MESSAGE',
            payload: { message: event.data, order: event.order, messageId: event.messageId },
          };
    case 'assistant_text_delta':
      return {
        type: 'WS_ASSISTANT_TEXT_DELTA',
        payload: {
          messageId: event.messageId,
          order: event.order,
          offset: event.offset,
          text: event.text,
        },
      };
    case 'error':
      return {
        type: 'WS_ERROR',
        payload: {
          message: event.message,
          ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
        },
      };
    case 'chat_capabilities':
      return { type: 'WS_CHAT_CAPABILITIES', payload: { capabilities: event.capabilities } };
    case 'permission_request':
      return createPermissionRequestAction(event);
    case 'user_question':
      return createUserQuestionAction(event);
    case 'permission_cancelled':
      return { type: 'WS_PERMISSION_CANCELLED', payload: { requestId: event.requestId } };
    case 'queue_updated':
      return { type: 'QUEUE_UPDATED', payload: { queuedMessages: event.queuedMessages } };
    case 'transcript_message_committed':
      return {
        type: 'TRANSCRIPT_MESSAGE_COMMITTED',
        payload: { message: event.chatMessage, queuedMessages: event.queuedMessages },
      };
    case 'pending_request_updated':
      return {
        type: 'PENDING_REQUEST_UPDATED',
        payload: { pendingInteractiveRequest: event.pendingInteractiveRequest },
      };
    case 'message_state_changed':
      return {
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: event.id,
          newState: event.newState,
          queuePosition: event.queuePosition,
          errorMessage: event.errorMessage,
          userMessage: event.userMessage,
        },
      };
    case 'tool_progress':
      return {
        type: 'SDK_TOOL_PROGRESS',
        payload: {
          toolUseId: event.tool_use_id,
          toolName: event.tool_name,
          elapsedSeconds: event.elapsed_time_seconds,
          acpLocations: event.acpLocations,
          acpKind: event.acpKind,
        },
      };
    case 'task_notification':
      return createTaskNotificationAction(event);
    case 'compact_boundary':
      return { type: 'COMPACT_BOUNDARY' };
    case 'compacting_start':
      return { type: 'SDK_COMPACTING_START' };
    case 'compacting_end':
      return { type: 'SDK_COMPACTING_END' };
    case 'slash_commands':
      return { type: 'WS_SLASH_COMMANDS', payload: { commands: event.slashCommands } };
    case 'config_options_update':
      return {
        type: 'CONFIG_OPTIONS_UPDATE',
        payload: {
          configOptions: event.configOptions.flatMap((option) => toAcpConfigOption(option) ?? []),
        },
      };
    case 'config_option_applied':
      return { type: 'CONFIG_OPTION_APPLIED', payload: { requestId: event.requestId } };
    // Browser-level events are dispatched by the transport, not the reducer.
    case 'subagents_changed':
    case 'workspace_notification_request':
      return null;
  }
}

/**
 * Maps a parsed server frame to its reducer action. Envelopes that the
 * transport unwraps or reassembles (`session_delta`, replay chunks) and
 * browser-level events have no action.
 */
export function createActionFromWebSocketMessage(message: WebSocketMessage): ChatAction | null {
  switch (message.type) {
    case 'session_snapshot':
      return createSnapshotAction(message);
    case 'session_replay_batch':
      // A batch without events carries only load metadata; replaying it would reset state.
      return message.replayEvents
        ? { type: 'SESSION_REPLAY_BATCH', payload: { replayEvents: message.replayEvents } }
        : null;
    case 'session_delta':
    case 'session_replay_chunk':
      return null;
    default:
      return createSessionEventAction(message);
  }
}
