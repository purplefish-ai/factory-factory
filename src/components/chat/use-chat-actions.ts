/**
 * Chat action callbacks hook.
 *
 * This hook provides stable action callbacks for:
 * - Sending messages
 * - Stopping chat
 * - Clearing chat
 * - Approving permissions
 * - Answering questions
 * - Updating settings
 * - Removing queued messages
 * - Task notifications
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

export interface UseChatActionsReturn {
  sendMessage: (text: string) => void;
  stopChat: () => void;
  clearChat: () => void;
  approvePermission: (requestId: string, allow: boolean, optionId?: string) => void;
  answerQuestion: (requestId: string, answers: Record<string, string | string[]>) => void;
  updateSettings: (settings: Partial<ChatSettings>) => void;
  removeQueuedMessage: (id: string) => void;
  resumeQueuedMessages: () => void;
  dismissTaskNotification: (id: string) => void;
  clearTaskNotifications: () => void;
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
    (text: string) => {
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
        settings: clampChatSettingsForCapabilities(
          stateRef.current.chatSettings,
          stateRef.current.chatCapabilities
        ),
      };
      send(msg);
    },
    [send, dispatch, inputAttachmentsRef, stateRef, onClearInput]
  );

  const stopChat = useCallback(() => {
    const { sessionStatus } = stateRef.current;
    // Only allow stop when running (not already stopping or idle)
    if (sessionStatus.phase === 'running') {
      dispatch({ type: 'STOP_REQUESTED' });
      send({ type: 'stop' } as StopMessage);
    }
  }, [send, dispatch, stateRef]);

  const clearChat = useCallback(() => {
    // Stop any running provider session process
    if (stateRef.current.sessionStatus.phase === 'running') {
      dispatch({ type: 'STOP_REQUESTED' });
      send({ type: 'stop' } as StopMessage);
    }

    // Clear state
    dispatch({ type: 'CLEAR_CHAT' });

    // The reconnect will be handled by the parent component that owns the transport
  }, [send, dispatch, stateRef]);

  const approvePermission = useCallback(
    (requestId: string, allow: boolean, optionId?: string) => {
      // Validate requestId matches pending permission to prevent stale responses
      const { pendingRequest } = stateRef.current;
      if (pendingRequest.type !== 'permission' || pendingRequest.request.requestId !== requestId) {
        return;
      }
      if (!optionId) {
        return;
      }
      const msg: PermissionResponseMessage = {
        type: 'permission_response',
        requestId,
        optionId,
      };
      send(msg);
      dispatch({ type: 'PERMISSION_RESPONSE', payload: { allow } });
    },
    [send, dispatch, stateRef]
  );

  const answerQuestion = useCallback(
    (requestId: string, answers: Record<string, string | string[]>) => {
      // Validate requestId matches pending question to prevent stale responses
      const { pendingRequest } = stateRef.current;
      if (pendingRequest.type !== 'question' || pendingRequest.request.requestId !== requestId) {
        return;
      }
      const msg = { type: 'question_response', requestId, answers };
      send(msg);
      dispatch({ type: 'QUESTION_RESPONSE' });
    },
    [send, dispatch, stateRef]
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

  const dismissTaskNotification = useCallback(
    (id: string) => {
      dispatch({ type: 'DISMISS_TASK_NOTIFICATION', payload: { id } });
    },
    [dispatch]
  );

  const clearTaskNotifications = useCallback(() => {
    dispatch({ type: 'CLEAR_TASK_NOTIFICATIONS' });
  }, [dispatch]);

  const setConfigOption = useCallback(
    (configId: string, value: string) => {
      const msg: SetConfigOptionMessage = {
        type: 'set_config_option',
        configId,
        value,
      };
      send(msg);
    },
    [send]
  );

  // Rewind files actions
  const rewindEnabled = stateRef.current.chatCapabilities.rewind.enabled;
  const startRewindPreview = useCallback(
    (userMessageUuid: string) => {
      if (!rewindEnabled) {
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

      // Send dry run request to get affected files
      const msg = {
        type: 'rewind_files',
        userMessageId: userMessageUuid,
        dryRun: true,
      };
      const sent = send(msg);

      // Check if message was sent successfully
      if (!sent) {
        dispatch({
          type: 'REWIND_PREVIEW_ERROR',
          payload: {
            error: 'Not connected to server. Please check your connection and try again.',
            requestNonce,
          },
        });
        return;
      }

      // Set timeout to handle case where response never arrives
      // Capture nonce in closure to ensure late timeouts are filtered correctly
      rewindTimeoutRef.current = setTimeout(() => {
        dispatch({
          type: 'REWIND_PREVIEW_ERROR',
          payload: { error: 'Request timed out. Please try again.', requestNonce },
        });
        rewindTimeoutRef.current = null;
      }, 30_000); // 30 second timeout
    },
    [send, dispatch, rewindEnabled, rewindTimeoutRef]
  );

  const confirmRewind = useCallback(() => {
    if (!rewindEnabled) {
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

    // Send actual rewind request (not dry run)
    const msg = {
      type: 'rewind_files',
      userMessageId: rewindPreview.userMessageId,
      dryRun: false,
    };
    const sent = send(msg);

    if (!sent) {
      dispatch({
        type: 'REWIND_PREVIEW_ERROR',
        payload: {
          error: 'Not connected to server. Please check your connection and try again.',
          requestNonce: rewindPreview.requestNonce,
        },
      });
      return;
    }

    // Set timeout to handle case where response never arrives
    // Capture nonce in closure to ensure late timeouts are filtered correctly
    const nonce = rewindPreview.requestNonce;
    rewindTimeoutRef.current = setTimeout(() => {
      dispatch({
        type: 'REWIND_PREVIEW_ERROR',
        payload: { error: 'Request timed out. Please try again.', requestNonce: nonce },
      });
      rewindTimeoutRef.current = null;
    }, 30_000); // 30 second timeout
  }, [send, dispatch, rewindEnabled, stateRef, rewindTimeoutRef]);

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
    clearChat,
    approvePermission,
    answerQuestion,
    updateSettings,
    removeQueuedMessage,
    resumeQueuedMessages,
    dismissTaskNotification,
    clearTaskNotifications,
    setConfigOption,
    startRewindPreview,
    confirmRewind,
    cancelRewind,
    getUuidForMessageId,
  };
}
