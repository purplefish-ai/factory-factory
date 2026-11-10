/**
 * Chat action callbacks hook.
 *
 * This hook provides stable action callbacks for:
 * - Sending messages
 * - Stopping chat
 * - Approving permissions
 * - Answering questions
 * - Updating settings
 * - Removing queued messages
 */

import { useCallback } from 'react';
import type { WebSocketSend, WebSocketSendOptions } from '@/hooks/use-websocket-transport';
import type { ChatSettings, MessageAttachment } from '@/lib/chat-protocol';
import { DEFAULT_THINKING_BUDGET } from '@/lib/chat-protocol';
import type {
  PermissionResponseMessage,
  QueueMessageInput,
  RemoveQueuedMessageInput,
  ResumeQueuedMessagesInput,
  SetConfigOptionMessage,
  SetModelMessage,
  StopMessage,
} from '@/shared/websocket';
import { persistSettings } from './chat-persistence';
import { clampChatSettingsForCapabilities, getConfigOptionSettings } from './chat-settings';
import type { ChatAction, ChatState } from './reducer';
import { reduceSettingsSlice } from './reducer/slices/settings';

// =============================================================================
// Types
// =============================================================================

type QueueMessageRequest = QueueMessageInput;
type RemoveQueuedMessageRequest = RemoveQueuedMessageInput;
type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

export interface UseChatActionsOptions {
  /** Send function from WebSocket transport */
  send: WebSocketSend;
  /** Dispatch function from reducer */
  dispatch: React.Dispatch<ChatAction>;
  /** State ref for stable callbacks */
  stateRef: React.MutableRefObject<ChatState>;
  /** Database session ID ref for persistence */
  dbSessionIdRef: React.MutableRefObject<string | null>;
  /** Input attachments ref for sendMessage */
  inputAttachmentsRef: React.MutableRefObject<MessageAttachment[]>;
  /** Callback to clear input draft and attachments */
  onClearInput: () => void;
}

export interface SendMessageOptions {
  voiceMode?: boolean;
  /** Send a context command without consuming the next message draft or attachments. */
  preserveInput?: boolean;
  /** Send these attachments instead of the composer's, e.g. when resending a message. */
  attachments?: MessageAttachment[];
}

export interface UseChatActionsReturn {
  sendMessage: (text: string, options?: SendMessageOptions) => void;
  stopChat: () => void;
  approvePermission: (requestId: string, allow: boolean, optionId?: string) => void;
  answerQuestion: (requestId: string, answers: Record<string, string | string[]>) => void;
  updateSettings: (settings: Partial<ChatSettings>) => void;
  removeQueuedMessage: (id: string) => void;
  steerQueuedMessage: (id: string) => void;
  resumeQueuedMessages: () => void;
  setConfigOption: (configId: string, value: string) => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

/** For settings rolled back when `send` returns false: never queue them for replay. */
const UNQUEUED_SEND: WebSocketSendOptions = { queuePolicy: 'drop' };

/** Shown in the transcript when a prompt answer could not be sent; the prompt stays open. */
const UNSENT_ANSWER_ERROR: ChatAction = {
  type: 'WS_ERROR',
  payload: { message: 'Your answer was not sent. Reconnect and answer again.' },
};

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function maybeSendThinkingBudgetUpdate(
  send: WebSocketSend,
  settings: Partial<ChatSettings>,
  thinkingEnabled: boolean
): void {
  if (!('thinkingEnabled' in settings && thinkingEnabled)) {
    return;
  }
  const maxTokens = settings.thinkingEnabled ? DEFAULT_THINKING_BUDGET : null;
  send({ type: 'set_thinking_budget', max_tokens: maxTokens });
}

function maybeSendModelUpdate(
  send: WebSocketSend,
  settings: Partial<ChatSettings>,
  newSettings: ChatSettings,
  capabilities: ChatState['chatCapabilities'],
  requestId: string | undefined
): boolean {
  const modelChanged = 'selectedModel' in settings;
  const reasoningChanged = 'reasoningEffort' in settings;
  if (!((modelChanged || reasoningChanged) && capabilities.model.enabled)) {
    return true;
  }

  const modelMessage: SetModelMessage = {
    type: 'set_model',
    model: newSettings.selectedModel,
    ...(requestId ? { requestId } : {}),
  };

  if (capabilities.reasoning.enabled) {
    modelMessage.reasoningEffort = newSettings.reasoningEffort;
  }

  // The caller rolls back an unsent selection, so it must not be replayed after reconnecting.
  return send(modelMessage, UNQUEUED_SEND);
}

function getOutboundSettings(state: ChatState): QueueMessageRequest['settings'] {
  return !state.chatCapabilitiesLoaded && state.modelSelectionSource === 'bootstrap'
    ? undefined
    : {
        ...clampChatSettingsForCapabilities(
          state.chatSettings,
          state.chatCapabilitiesLoaded ? state.chatCapabilities : undefined
        ),
        selectedModel:
          state.modelSelectionSource === 'bootstrap' ? null : state.chatSettings.selectedModel,
      };
}

function findOptionIdByDecision(
  options: AcpPermissionOption[] | undefined,
  allow: boolean
): string | undefined {
  if (!options || options.length === 0) {
    return undefined;
  }

  const preferred = options.find((option) =>
    allow ? option.kind.startsWith('allow') : option.kind.startsWith('reject')
  );
  return preferred?.optionId ?? options[0]?.optionId;
}

function getLegacyPermissionOptionId(toolName: string, allow: boolean): string {
  // Claude ExitPlanMode uses "default" (approve) and "plan" (reject).
  if (toolName === 'ExitPlanMode') {
    return allow ? 'default' : 'plan';
  }
  // Generic ACP tools conventionally use "allow" / "reject".
  return allow ? 'allow' : 'reject';
}

function normalizeQuestionAnswers(
  answers: Record<string, string | string[]>
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    const values = (Array.isArray(value) ? value : [value])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (values.length > 0) {
      normalized[questionId] = values;
    }
  }
  return normalized;
}

function isAllowOptionId(optionId: string, options: AcpPermissionOption[] | undefined): boolean {
  const matchedOption = options?.find((option) => option.optionId === optionId);
  if (matchedOption) {
    return matchedOption.kind.startsWith('allow');
  }
  return optionId === 'allow' || optionId === 'allow_once' || optionId === 'default';
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for chat action callbacks.
 * All callbacks are stable and use refs internally to avoid recreation on state changes.
 */
export function useChatActions(options: UseChatActionsOptions): UseChatActionsReturn {
  const { send, dispatch, stateRef, dbSessionIdRef, inputAttachmentsRef, onClearInput } = options;

  // Keep sequential actions (for example selecting a model then immediately sending)
  // on the same settings even before React commits the reducer render.
  const applySettings = useCallback(
    (settings: Partial<ChatSettings>, requestId?: string) => {
      const action: ChatAction = { type: 'UPDATE_SETTINGS', payload: settings, requestId };
      stateRef.current = reduceSettingsSlice(stateRef.current, action);
      dispatch(action);
      persistSettings(dbSessionIdRef.current, stateRef.current.chatSettings);
    },
    [dispatch, stateRef, dbSessionIdRef]
  );

  const rejectUnsentModelRequest = useCallback(
    (requestId: string | undefined) => {
      if (!requestId) {
        return;
      }
      const action: ChatAction = {
        type: 'WS_ERROR',
        payload: {
          requestId,
          message: 'Setting change was not sent. Reconnect and try again.',
        },
      };
      stateRef.current = reduceSettingsSlice(stateRef.current, action);
      dispatch(action);
      persistSettings(dbSessionIdRef.current, stateRef.current.chatSettings);
    },
    [dispatch, stateRef, dbSessionIdRef]
  );

  const sendMessage = useCallback(
    (text: string, options?: SendMessageOptions) => {
      const trimmedText = text.trim();
      const attachments =
        options?.attachments ?? (options?.preserveInput ? [] : inputAttachmentsRef.current);
      if (!trimmedText && attachments.length === 0) {
        return;
      }

      // Generate single ID for tracking
      const id = generateMessageId();

      // Mark message as pending backend confirmation (shows "sending..." indicator)
      // Store text and attachments for recovery if message is rejected
      dispatch({
        type: 'MESSAGE_SENDING',
        payload: {
          id,
          text: trimmedText,
          attachments: attachments.length > 0 ? attachments : undefined,
          sessionId: dbSessionIdRef.current,
        },
      });

      // Context commands leave the next message draft intact.
      if (!options?.preserveInput) {
        onClearInput();
      }

      // Send to backend for queueing/dispatch
      // The transcript shows pending content until the backend confirms the message.
      const msg: QueueMessageRequest = {
        type: 'queue_message',
        id,
        text: trimmedText,
        attachments: attachments.length > 0 ? attachments : undefined,
        voiceMode: options?.voiceMode,
        settings: getOutboundSettings(stateRef.current),
      };
      send(msg);
    },
    [send, dispatch, dbSessionIdRef, inputAttachmentsRef, stateRef, onClearInput]
  );

  const completePlanApproval = useCallback(() => {
    applySettings({ planModeEnabled: false });
  }, [applySettings]);

  const stopChat = useCallback(() => {
    const { sessionStatus } = stateRef.current;
    // Only allow stop when running (not already stopping or idle)
    if (sessionStatus.phase === 'running') {
      dispatch({ type: 'STOP_REQUESTED' });
      send({ type: 'stop' } as StopMessage);
    }
  }, [send, dispatch, stateRef]);

  const approvePermission = useCallback(
    (requestId: string, allow: boolean, optionId?: string) => {
      // Validate requestId matches pending permission to prevent stale responses
      const state = stateRef.current;
      const { pendingRequest } = state;
      if (pendingRequest.type !== 'permission' || pendingRequest.request.requestId !== requestId) {
        return;
      }
      const resolvedOptionId =
        optionId ??
        findOptionIdByDecision(pendingRequest.request.acpOptions, allow) ??
        getLegacyPermissionOptionId(pendingRequest.request.toolName, allow);
      const msg: PermissionResponseMessage = {
        type: 'permission_response',
        requestId,
        optionId: resolvedOptionId,
      };
      // Like steering: the prompt closes only once the answer is sent, so a
      // refused send (disconnected) leaves it open to answer again.
      if (!send(msg, UNQUEUED_SEND)) {
        dispatch(UNSENT_ANSWER_ERROR);
        return;
      }
      dispatch({ type: 'PERMISSION_RESPONSE', payload: { allow } });

      if (allow && pendingRequest.request.toolName === 'ExitPlanMode') {
        completePlanApproval();
      }
    },
    [send, dispatch, stateRef, completePlanApproval]
  );

  const answerQuestion = useCallback(
    (requestId: string, answers: Record<string, string | string[]>) => {
      // Validate requestId matches pending question to prevent stale responses
      const state = stateRef.current;
      const { pendingRequest } = state;
      if (pendingRequest.type !== 'question' || pendingRequest.request.requestId !== requestId) {
        return;
      }
      const normalizedAnswers = normalizeQuestionAnswers(answers);
      const optionId = findOptionIdByDecision(pendingRequest.request.acpOptions, true) ?? 'allow';
      const msg: PermissionResponseMessage = {
        type: 'permission_response',
        requestId,
        optionId,
        ...(Object.keys(normalizedAnswers).length > 0 ? { answers: normalizedAnswers } : {}),
      };
      if (!send(msg, UNQUEUED_SEND)) {
        dispatch(UNSENT_ANSWER_ERROR);
        return;
      }
      dispatch({ type: 'QUESTION_RESPONSE' });

      if (
        pendingRequest.request.toolName === 'ExitPlanMode' &&
        isAllowOptionId(optionId, pendingRequest.request.acpOptions)
      ) {
        completePlanApproval();
      }
    },
    [send, dispatch, stateRef, completePlanApproval]
  );

  const updateSettings = useCallback(
    (settings: Partial<ChatSettings>) => {
      const requestId = settings.selectedModel !== undefined ? crypto.randomUUID() : undefined;
      applySettings(settings, requestId);
      // Persist capability-aware settings to avoid invalid provider combinations.
      const capabilities = stateRef.current.chatCapabilities;
      const newSettings = stateRef.current.chatSettings;
      maybeSendThinkingBudgetUpdate(send, settings, capabilities.thinking.enabled);
      if (!maybeSendModelUpdate(send, settings, newSettings, capabilities, requestId)) {
        rejectUnsentModelRequest(requestId);
      }
    },
    [send, applySettings, rejectUnsentModelRequest, stateRef]
  );

  const removeQueuedMessage = useCallback(
    (id: string) => {
      // Send removal request to backend
      const msg: RemoveQueuedMessageRequest = {
        type: 'remove_queued_message',
        messageId: id,
      };
      send(msg);
      // State update will come via message_removed WebSocket event
    },
    [send]
  );

  const steerQueuedMessage = useCallback(
    (id: string) => {
      if (stateRef.current.pendingSteer) {
        return;
      }
      const requestId = crypto.randomUUID();
      const pendingSteer = { messageId: id, requestId };
      stateRef.current = { ...stateRef.current, pendingSteer };
      dispatch({ type: 'STEER_REQUESTED', ...pendingSteer });
      if (!send({ type: 'steer_queued_message', messageId: id, requestId }, UNQUEUED_SEND)) {
        stateRef.current = { ...stateRef.current, pendingSteer: null };
        dispatch({ type: 'STEER_SETTLED', requestId });
      }
      // Keep the message queued until the server confirms native delivery.
    },
    [send, dispatch, stateRef]
  );

  const resumeQueuedMessages = useCallback(() => {
    send({ type: 'resume_queued_messages' } as ResumeQueuedMessagesInput);
  }, [send]);

  const setConfigOption = useCallback(
    (configId: string, value: string) => {
      const settings = getConfigOptionSettings(stateRef.current, configId, value);
      const requestId = crypto.randomUUID();
      const action: ChatAction = {
        type: 'CONFIG_OPTION_REQUESTED',
        payload: { configId, value, requestId },
      };
      stateRef.current = reduceSettingsSlice(stateRef.current, action);
      dispatch(action);
      if (Object.keys(settings).length > 0) {
        applySettings(settings, requestId);
      }
      const msg: SetConfigOptionMessage = {
        type: 'set_config_option',
        configId,
        value,
        ...(requestId ? { requestId } : {}),
      };
      if (!send(msg, UNQUEUED_SEND)) {
        rejectUnsentModelRequest(requestId);
      }
    },
    [send, applySettings, rejectUnsentModelRequest, stateRef, dispatch]
  );

  return {
    sendMessage,
    stopChat,
    approvePermission,
    answerQuestion,
    updateSettings,
    removeQueuedMessage,
    steerQueuedMessage,
    resumeQueuedMessages,
    setConfigOption,
  };
}
