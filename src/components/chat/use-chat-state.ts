'use client';

/**
 * Chat state management hook using the chat reducer and persistence modules.
 *
 * This hook manages:
 * - Chat state via useReducer (messages, running state, permissions, etc.)
 * - Session persistence (settings, drafts)
 * - WebSocket message handling (converts to reducer actions)
 * - Action callbacks for UI (sendMessage, stopChat, etc.)
 * - Session switching effects
 *
 * Message queue is managed on the backend - frontend sends queue_message and
 * receives message_state_changed events for state transitions. On connect,
 * messages_snapshot restores full state.
 *
 * Usage:
 * ```ts
 * const { connected, send, reconnect } = useWebSocketTransport({ url, onMessage: handleMessage });
 * const chatState = useChatState({
 *   dbSessionId,
 *   send,
 *   connected,
 * });
 * // Pass chatState.handleMessage to transport's onMessage callback
 * ```
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ChatSettings, MessageAttachment, QueuedMessage } from '@/lib/claude-types';
import { DEFAULT_CHAT_SETTINGS, DEFAULT_THINKING_BUDGET } from '@/lib/claude-types';
import { createDebugLogger } from '@/lib/debug';
import type {
  PermissionResponseMessage,
  QuestionResponseMessage,
  QueueMessageInput,
  RemoveQueuedMessageInput,
  RewindFilesMessage,
  StopMessage,
} from '@/shared/websocket';
import { clearDraft, loadAllSessionData, persistDraft, persistSettings } from './chat-persistence';
import { type ChatState, chatReducer, createInitialChatState } from './chat-reducer';
import { useChatTransport } from './use-chat-transport';

// =============================================================================
// Debug Logging
// =============================================================================

const DEBUG_CHAT_STATE = false;
const debug = createDebugLogger(DEBUG_CHAT_STATE);

// =============================================================================
// Types
// =============================================================================

export interface UseChatStateOptions {
  /** Database session ID (required for persistence). */
  dbSessionId: string | null;
  /** Send function from WebSocket transport. */
  send: (message: unknown) => boolean;
  /** Connection state from WebSocket transport. */
  connected: boolean;
}

export interface UseChatStateReturn extends Omit<ChatState, 'queuedMessages'> {
  // Override queuedMessages to expose as array for UI consumption
  // (Internal state uses Map for O(1) lookups and automatic de-duplication)
  queuedMessages: QueuedMessage[];
  // Actions
  sendMessage: (text: string) => void;
  stopChat: () => void;
  clearChat: () => void;
  approvePermission: (requestId: string, allow: boolean) => void;
  answerQuestion: (requestId: string, answers: Record<string, string | string[]>) => void;
  updateSettings: (settings: Partial<ChatSettings>) => void;
  // Additional state/actions
  inputDraft: string;
  setInputDraft: (draft: string) => void;
  inputAttachments: MessageAttachment[];
  setInputAttachments: (attachments: MessageAttachment[]) => void;
  removeQueuedMessage: (id: string) => void;
  // Task notification actions
  dismissTaskNotification: (id: string) => void;
  clearTaskNotifications: () => void;
  // Rewind files actions
  startRewindPreview: (userMessageUuid: string) => void;
  confirmRewind: () => void;
  cancelRewind: () => void;
  /** Get the SDK-assigned UUID for a user message by its stable message ID */
  getUuidForMessageId: (messageId: string) => string | undefined;
  // Message handler for transport
  handleMessage: (data: unknown) => void;
  // Refs for UI
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  // Connection state (passed through from transport)
  connected: boolean;
}

// =============================================================================
// WebSocket Message Types (outgoing) - used by action callbacks
// =============================================================================

type QueueMessageRequest = QueueMessageInput;
type RemoveQueuedMessageRequest = RemoveQueuedMessageInput;
type RewindFilesRequest = RewindFilesMessage;

// =============================================================================
// Helper Functions
// =============================================================================

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useChatState(options: UseChatStateOptions): UseChatStateReturn {
  const { dbSessionId, send, connected } = options;

  // Reducer for chat state
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialChatState);

  // Local state for input draft (not in reducer since it's UI-specific)
  const [inputDraft, setInputDraftState] = useState('');
  // Local state for input attachments (for recovery on rejection)
  const [inputAttachments, setInputAttachments] = useState<MessageAttachment[]>([]);

  // Refs
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Track dbSessionId in a ref to use without stale closures
  const dbSessionIdRef = useRef<string | null>(dbSessionId ?? null);
  // Track previous dbSessionId to detect session switches
  const prevDbSessionIdRef = useRef<string | null>(null);
  // Track accumulated tool input JSON per tool_use_id for streaming
  const toolInputAccumulatorRef = useRef<Map<string, string>>(new Map());
  // Track current state in a ref for stable callbacks (avoids callback recreation on state changes)
  const stateRef = useRef(state);
  stateRef.current = state;
  // Track input attachments in a ref for stable sendMessage callback
  const inputAttachmentsRef = useRef(inputAttachments);
  inputAttachmentsRef.current = inputAttachments;
  // Track rewind preview timeout for cleanup
  const rewindTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // =============================================================================
  // Session Switching Effect
  // =============================================================================

  /**
   * Session switching and settings loading.
   *
   * Settings precedence (highest to lowest):
   * 1. User-modified settings during the session
   * 2. Stored session settings from sessionStorage
   * 3. Application defaults (DEFAULT_CHAT_SETTINGS)
   *
   * Note: Backend does not broadcast session-level settings.
   * Settings are persisted locally per session.
   */
  useEffect(() => {
    const prevDbSessionId = prevDbSessionIdRef.current;
    const newDbSessionId = dbSessionId ?? null;

    // Update refs
    dbSessionIdRef.current = newDbSessionId;
    prevDbSessionIdRef.current = newDbSessionId;

    // If switching to a different session, reset local state
    if (prevDbSessionId !== null && prevDbSessionId !== newDbSessionId) {
      debug.log('Session switch detected', { from: prevDbSessionId, to: newDbSessionId });

      // Dispatch session switch to reset reducer state
      dispatch({ type: 'SESSION_SWITCH_START' });

      // Clear tool input accumulator
      toolInputAccumulatorRef.current.clear();
    }

    // Load persisted data for the new session (queue comes from backend via messages_snapshot)
    if (newDbSessionId) {
      const persistedData = loadAllSessionData(newDbSessionId);
      setInputDraftState(persistedData.draft);
      dispatch({ type: 'SET_SETTINGS', payload: persistedData.settings });
      // Queue is loaded from backend via messages_snapshot event, not from frontend persistence

      // Set loading state for initial load (when prevDbSessionId was null)
      // This prevents "No messages yet" flash while WebSocket connects and loads session
      // For session switches, SESSION_SWITCH_START already set loadingSession: true
      if (prevDbSessionId === null) {
        dispatch({ type: 'SESSION_LOADING_START' });
      }
    } else {
      setInputDraftState('');
      dispatch({ type: 'SET_SETTINGS', payload: DEFAULT_CHAT_SETTINGS });
    }
  }, [dbSessionId]);

  // =============================================================================
  // Rejected Message Recovery Effect
  // =============================================================================

  // When a message is rejected, restore the text and attachments to the input for retry
  useEffect(() => {
    if (state.lastRejectedMessage) {
      const { text, attachments, error } = state.lastRejectedMessage;
      // Restore the message text to the input so user can retry
      setInputDraftState(text);
      // Restore attachments if present
      if (attachments && attachments.length > 0) {
        setInputAttachments(attachments);
      }
      // Log the error for debugging
      debug.log('Message rejected, restored to draft:', { text, attachments, error });
      // Clear the rejected message state after processing
      dispatch({ type: 'CLEAR_REJECTED_MESSAGE' });
    }
  }, [state.lastRejectedMessage]);

  const { handleMessage } = useChatTransport({
    dispatch,
    stateRef,
    toolInputAccumulatorRef,
    rewindTimeoutRef,
  });

  // =============================================================================
  // Action Callbacks
  // =============================================================================

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
      setInputDraftState('');
      setInputAttachments([]);
      clearDraft(dbSessionIdRef.current);

      // Send to backend for queueing/dispatch
      // Message will be added to state when MESSAGE_ACCEPTED is received
      const msg: QueueMessageRequest = {
        type: 'queue_message',
        id,
        text: trimmedText,
        attachments: attachments.length > 0 ? attachments : undefined,
        settings: stateRef.current.chatSettings,
      };
      send(msg);
    },
    [send]
  );

  const stopChat = useCallback(() => {
    const { sessionStatus } = stateRef.current;
    // Only allow stop when running (not already stopping or idle)
    if (sessionStatus.phase === 'running') {
      dispatch({ type: 'STOP_REQUESTED' });
      send({ type: 'stop' } as StopMessage);
    }
  }, [send]);

  const clearChat = useCallback(() => {
    // Stop any running Claude process
    if (stateRef.current.sessionStatus.phase === 'running') {
      dispatch({ type: 'STOP_REQUESTED' });
      send({ type: 'stop' } as StopMessage);
    }

    // Clear state
    dispatch({ type: 'CLEAR_CHAT' });
    toolInputAccumulatorRef.current.clear();

    // The reconnect will be handled by the parent component that owns the transport
  }, [send]);

  const approvePermission = useCallback(
    (requestId: string, allow: boolean) => {
      // Validate requestId matches pending permission to prevent stale responses
      const { pendingRequest } = stateRef.current;
      if (pendingRequest.type !== 'permission' || pendingRequest.request.requestId !== requestId) {
        return;
      }
      const msg: PermissionResponseMessage = { type: 'permission_response', requestId, allow };
      send(msg);
      dispatch({ type: 'PERMISSION_RESPONSE', payload: { allow } });
    },
    [send]
  );

  const answerQuestion = useCallback(
    (requestId: string, answers: Record<string, string | string[]>) => {
      // Validate requestId matches pending question to prevent stale responses
      const { pendingRequest } = stateRef.current;
      if (pendingRequest.type !== 'question' || pendingRequest.request.requestId !== requestId) {
        return;
      }
      const msg: QuestionResponseMessage = { type: 'question_response', requestId, answers };
      send(msg);
      dispatch({ type: 'QUESTION_RESPONSE' });
    },
    [send]
  );

  const updateSettings = useCallback(
    (settings: Partial<ChatSettings>) => {
      dispatch({ type: 'UPDATE_SETTINGS', payload: settings });
      // Persist updated settings
      const newSettings = { ...stateRef.current.chatSettings, ...settings };
      persistSettings(dbSessionIdRef.current, newSettings);

      // Send thinking budget update when thinkingEnabled changes
      if ('thinkingEnabled' in settings) {
        const maxTokens = settings.thinkingEnabled ? DEFAULT_THINKING_BUDGET : null;
        send({ type: 'set_thinking_budget', max_tokens: maxTokens });
      }
    },
    [send]
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

  const dismissTaskNotification = useCallback((id: string) => {
    dispatch({ type: 'DISMISS_TASK_NOTIFICATION', payload: { id } });
  }, []);

  const clearTaskNotifications = useCallback(() => {
    dispatch({ type: 'CLEAR_TASK_NOTIFICATIONS' });
  }, []);

  // Rewind files actions
  const startRewindPreview = useCallback(
    (userMessageUuid: string) => {
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
      const msg: RewindFilesRequest = {
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
    [send]
  );

  const confirmRewind = useCallback(() => {
    // Clear any existing timeout
    if (rewindTimeoutRef.current) {
      clearTimeout(rewindTimeoutRef.current);
      rewindTimeoutRef.current = null;
    }

    const rewindPreview = stateRef.current.rewindPreview;
    if (!rewindPreview) {
      debug.log('[Chat] confirmRewind called but rewindPreview is null - potential race condition');
      return;
    }

    // Mark as executing (keep dialog open with loading state for actual rewind)
    dispatch({ type: 'REWIND_EXECUTING' });

    // Send actual rewind request (not dry run)
    const msg: RewindFilesRequest = {
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
  }, [send]);

  const cancelRewind = useCallback(() => {
    // Clear the timeout when canceling
    if (rewindTimeoutRef.current) {
      clearTimeout(rewindTimeoutRef.current);
      rewindTimeoutRef.current = null;
    }
    dispatch({ type: 'REWIND_CANCEL' });
  }, []);

  const getUuidForMessageId = useCallback((messageId: string): string | undefined => {
    // Look up UUID by message ID (stable identifier)
    return stateRef.current.messageIdToUuid.get(messageId);
  }, []);

  // Debounce sessionStorage persistence to avoid blocking on every keystroke
  const persistDraftDebounced = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Wrap setInputDraft to persist to sessionStorage (debounced)
  const setInputDraft = useCallback((draft: string) => {
    setInputDraftState(draft);

    // Debounce sessionStorage write to avoid blocking main thread on every keystroke
    if (persistDraftDebounced.current) {
      clearTimeout(persistDraftDebounced.current);
    }
    persistDraftDebounced.current = setTimeout(() => {
      persistDraft(dbSessionIdRef.current, draft);
    }, 300);
  }, []);

  // Clean up pending debounced persist and rewind timeout on unmount
  useEffect(() => {
    return () => {
      if (persistDraftDebounced.current) {
        clearTimeout(persistDraftDebounced.current);
      }
      if (rewindTimeoutRef.current) {
        clearTimeout(rewindTimeoutRef.current);
      }
    };
  }, []);

  // =============================================================================
  // Return Value
  // =============================================================================

  // Callbacks are stable (use refs internally), so we only need state and connected in deps
  return useMemo(
    () => ({
      // Spread all state from reducer
      ...state,
      // Convert queuedMessages Map to array for UI consumption
      // (Internal state uses Map for O(1) lookups and automatic de-duplication)
      queuedMessages: Array.from(state.queuedMessages.values()),
      // Connection state from transport
      connected,
      // Actions (stable - use stateRef internally)
      sendMessage,
      stopChat,
      clearChat,
      approvePermission,
      answerQuestion,
      updateSettings,
      // Additional state/actions
      inputDraft,
      setInputDraft,
      inputAttachments,
      setInputAttachments,
      removeQueuedMessage,
      dismissTaskNotification,
      clearTaskNotifications,
      // Rewind files actions
      startRewindPreview,
      confirmRewind,
      cancelRewind,
      getUuidForMessageId,
      // Message handler for transport (stable - no deps)
      handleMessage,
      // Refs for UI
      inputRef,
      messagesEndRef,
    }),
    [
      state,
      connected,
      inputDraft,
      inputAttachments,
      // These are stable but included for exhaustive-deps correctness
      sendMessage,
      stopChat,
      clearChat,
      approvePermission,
      answerQuestion,
      updateSettings,
      setInputDraft,
      removeQueuedMessage,
      dismissTaskNotification,
      clearTaskNotifications,
      startRewindPreview,
      confirmRewind,
      cancelRewind,
      getUuidForMessageId,
      handleMessage,
    ]
  );
}
