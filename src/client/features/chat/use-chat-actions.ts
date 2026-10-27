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
 * - Rewind files operations
 */

import { useCallback } from 'react';
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
import { clampChatSettingsForCapabilities } from './chat-settings';
import type { ChatAction, ChatState } from './reducer';

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
  send: (message: unknown) => boolean;
  /** Dispatch function from reducer */
  dispatch: React.Dispatch<ChatAction>;
  /** State ref for stable callbacks */
  stateRef: React.MutableRefObject<ChatState>;
  /** Database session ID ref for persistence */
  dbSessionIdRef: React.MutableRefObject<string | null>;
  /** Input attachments ref for sendMessage */
  inputAttachmentsRef: React.MutableRefObject<MessageAttachment[]>;
  /** Rewind timeout ref for cleanup */
  rewindTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  /** Callback to clear input draft and attachments */
  onClearInput: () => void;
}

export interface SendMessageOptions {
  voiceMode?: boolean;
}

export interface UseChatActionsReturn {
  sendMessage: (text: string, options?: SendMessageOptions) => void;
  stopChat: () => void;
  approvePermission: (requestId: string, allow: boolean, optionId?: string) => void;
  answerQuestion: (requestId: string, answers: Record<string, string | string[]>) => void;
  updateSettings: (settings: Partial<ChatSettings>) => void;
  removeQueuedMessage: (id: string) => void;
  resumeQueuedMessages: () => void;
  setConfigOption: (configId: string, value: string) => void;
  startRewindPreview: (userMessageUuid: string) => void;
  confirmRewind: () => void;
  cancelRewind: () => void;
  getUuidForMessageId: (messageId: string) => string | undefined;
}

// =============================================================================
// Helper Functions
// =============================================================================

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function maybeSendThinkingBudgetUpdate(
  send: (message: unknown) => boolean,
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
  send: (message: unknown) => boolean,
  settings: Partial<ChatSettings>,
  newSettings: ChatSettings,
  capabilities: ChatState['chatCapabilities']
): void {
  const modelChanged = 'selectedModel' in settings;
  const reasoningChanged = 'reasoningEffort' in settings;
  if (!((modelChanged || reasoningChanged) && capabilities.model.enabled)) {
    return;
  }

  const modelMessage: SetModelMessage = {
    type: 'set_model',
    model: newSettings.selectedModel,
  };

  if (capabilities.reasoning.enabled) {
    if (reasoningChanged) {
      modelMessage.reasoningEffort = newSettings.reasoningEffort;
    } else if (modelChanged) {
      modelMessage.reasoningEffort = null;
    }
  }

  send(modelMessage);
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
  const {
    send,
    dispatch,
    stateRef,
    dbSessionIdRef,
    inputAttachmentsRef,
    rewindTimeoutRef,
    onClearInput,
  } = options;

  const sendMessage = useCallback(
    (text: string, options?: SendMessageOptions) => {
      const trimmedText = text.trim();
      const attachments = inputAttachmentsRef.current;
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

      // Clear draft and attachments when sending a message
      onClearInput();

      // Send to backend for queueing/dispatch
      // Message will be added to state when MESSAGE_ACCEPTED is received
      const msg: QueueMessageRequest = {
        type: 'queue_message',
        id,
        text: trimmedText,
        attachments: attachments.length > 0 ? attachments : undefined,
        voiceMode: options?.voiceMode,
        settings: clampChatSettingsForCapabilities(
          stateRef.current.chatSettings,
          stateRef.current.chatCapabilities
        ),
      };
      send(msg);
    },
    [send, dispatch, dbSessionIdRef, inputAttachmentsRef, stateRef, onClearInput]
  );

  const completePlanApproval = useCallback(
    (state: ChatState) => {
      dispatch({ type: 'UPDATE_SETTINGS', payload: { planModeEnabled: false } });
      const syncedSettings = clampChatSettingsForCapabilities(
        { ...state.chatSettings, planModeEnabled: false },
        state.chatCapabilities
      );
      persistSettings(dbSessionIdRef.current, syncedSettings);
    },
    [dispatch, dbSessionIdRef]
  );

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
      send(msg);
      dispatch({ type: 'PERMISSION_RESPONSE', payload: { allow } });

      if (allow && pendingRequest.request.toolName === 'ExitPlanMode') {
        completePlanApproval(state);
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
      send(msg);
      dispatch({ type: 'QUESTION_RESPONSE' });

      if (
        pendingRequest.request.toolName === 'ExitPlanMode' &&
        isAllowOptionId(optionId, pendingRequest.request.acpOptions)
      ) {
        completePlanApproval(state);
      }
    },
    [send, dispatch, stateRef, completePlanApproval]
  );

  const updateSettings = useCallback(
    (settings: Partial<ChatSettings>) => {
      dispatch({ type: 'UPDATE_SETTINGS', payload: settings });
      // Persist capability-aware settings to avoid invalid provider combinations.
      const capabilities = stateRef.current.chatCapabilities;
      const newSettings = clampChatSettingsForCapabilities(
        { ...stateRef.current.chatSettings, ...settings },
        capabilities
      );
      persistSettings(dbSessionIdRef.current, newSettings);
      maybeSendThinkingBudgetUpdate(send, settings, capabilities.thinking.enabled);
      maybeSendModelUpdate(send, settings, newSettings, capabilities);
    },
    [send, dispatch, stateRef, dbSessionIdRef]
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

  const resumeQueuedMessages = useCallback(() => {
    send({ type: 'resume_queued_messages' } as ResumeQueuedMessagesInput);
  }, [send]);

  const setConfigOption = useCallback(
    (configId: string, value: string) => {
      const msg: SetConfigOptionMessage = {
        type: 'set_config_option',
        configId,
        value,
      };
      send(msg);

      // When the model is chosen through the ACP config selector, mirror it into chatSettings.
      // Otherwise chatSettings.selectedModel keeps its stale default and the model re-applied at
      // message dispatch (setSessionModel) clobbers the user's pick right before the turn runs.
      const changedOption = stateRef.current.acpConfigOptions?.find(
        (option) => option.id === configId
      );
      const isModelOption = configId === 'model' || changedOption?.category === 'model';
      const isPlanningOption =
        stateRef.current.chatCapabilities.provider === 'CODEX'
          ? configId === 'collaboration_mode' || changedOption?.category === 'collaboration_mode'
          : configId === 'mode' || changedOption?.category === 'mode';
      if (isPlanningOption) {
        const planModeEnabled = value === 'plan';
        dispatch({ type: 'UPDATE_SETTINGS', payload: { planModeEnabled } });
        persistSettings(
          dbSessionIdRef.current,
          clampChatSettingsForCapabilities(
            { ...stateRef.current.chatSettings, planModeEnabled },
            stateRef.current.chatCapabilities
          )
        );
      }
      if (isModelOption) {
        dispatch({ type: 'UPDATE_SETTINGS', payload: { selectedModel: value } });
        const syncedSettings = clampChatSettingsForCapabilities(
          { ...stateRef.current.chatSettings, selectedModel: value },
          stateRef.current.chatCapabilities
        );
        persistSettings(dbSessionIdRef.current, syncedSettings);
      }
    },
    [send, dispatch, stateRef, dbSessionIdRef]
  );

  // Rewind files actions
  const startRewindPreview = useCallback(
    (userMessageUuid: string) => {
      if (!stateRef.current.chatCapabilities.rewind.enabled) {
        return;
      }

      // Clear any existing timeout
      if (rewindTimeoutRef.current) {
        clearTimeout(rewindTimeoutRef.current);
        rewindTimeoutRef.current = null;
      }

      // Generate unique nonce for this request (handles retry race conditions)
      const requestNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      // Start preview state first - this ensures the reducer can handle error states
      dispatch({
        type: 'REWIND_PREVIEW_START',
        payload: { userMessageId: userMessageUuid, requestNonce },
      });

      dispatch({
        type: 'REWIND_PREVIEW_ERROR',
        payload: { error: 'Rewind is not supported in ACP runtime.', requestNonce },
      });
    },
    [dispatch, stateRef, rewindTimeoutRef]
  );

  const confirmRewind = useCallback(() => {
    if (!stateRef.current.chatCapabilities.rewind.enabled) {
      return;
    }

    // Clear any existing timeout
    if (rewindTimeoutRef.current) {
      clearTimeout(rewindTimeoutRef.current);
      rewindTimeoutRef.current = null;
    }

    const rewindPreview = stateRef.current.rewindPreview;
    if (!rewindPreview) {
      return;
    }

    // Mark as executing (keep dialog open with loading state for actual rewind)
    dispatch({ type: 'REWIND_EXECUTING' });

    dispatch({
      type: 'REWIND_PREVIEW_ERROR',
      payload: {
        error: 'Rewind is not supported in ACP runtime.',
        requestNonce: rewindPreview.requestNonce,
      },
    });
  }, [dispatch, stateRef, rewindTimeoutRef]);

  const cancelRewind = useCallback(() => {
    // Clear the timeout when canceling
    if (rewindTimeoutRef.current) {
      clearTimeout(rewindTimeoutRef.current);
      rewindTimeoutRef.current = null;
    }
    dispatch({ type: 'REWIND_CANCEL' });
  }, [dispatch, rewindTimeoutRef]);

  const getUuidForMessageId = useCallback(
    (messageId: string): string | undefined => {
      // Look up UUID by message ID (stable identifier)
      return stateRef.current.messageIdToUuid.get(messageId);
    },
    [stateRef]
  );

  return {
    sendMessage,
    stopChat,
    approvePermission,
    answerQuestion,
    updateSettings,
    removeQueuedMessage,
    resumeQueuedMessages,
    setConfigOption,
    startRewindPreview,
    confirmRewind,
    cancelRewind,
    getUuidForMessageId,
  };
}
