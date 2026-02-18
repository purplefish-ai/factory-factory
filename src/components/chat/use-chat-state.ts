/**
 * Chat state management hook using the chat reducer and persistence modules.
 *
 * This hook manages:
 * - Chat state via useReducer (messages, running state, permissions, etc.)
 * - Session persistence (settings, drafts, input attachments)
 * - WebSocket message handling (converts to reducer actions)
 * - Action callbacks for UI (sendMessage, stopChat, etc.)
 * - Session switching effects
 *
 * Message queue is managed on the backend - frontend sends queue_message and
 * receives message_state_changed events for state transitions. On connect,
 * session_snapshot or session_replay_batch restores full state.
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
import type { ChatSettings, MessageAttachment, QueuedMessage } from '@/lib/chat-protocol';
import {
  clearInputAttachments as clearPersistedInputAttachments,
  loadInputAttachments,
  persistInputAttachments,
} from './chat-persistence';
import { type ChatAction, type ChatState, chatReducer, createInitialChatState } from './reducer';
import { createToolInputAccumulatorState } from './streaming-utils';
import { useChatActions } from './use-chat-actions';
import { useChatPersistence } from './use-chat-persistence';
import { useChatSession } from './use-chat-session';
import { useChatTransport } from './use-chat-transport';

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
  approvePermission: (requestId: string, allow: boolean, optionId?: string) => void;
  answerQuestion: (requestId: string, answers: Record<string, string | string[]>) => void;
  updateSettings: (settings: Partial<ChatSettings>) => void;
  // Additional state/actions
  inputDraft: string;
  setInputDraft: (draft: string) => void;
  inputAttachments: MessageAttachment[];
  setInputAttachments: (attachments: MessageAttachment[]) => void;
  removeQueuedMessage: (id: string) => void;
  resumeQueuedMessages: () => void;
  // Task notification actions
  dismissTaskNotification: (id: string) => void;
  clearTaskNotifications: () => void;
  // ACP config option action
  setConfigOption: (configId: string, value: string) => void;
  // Rewind files actions
  startRewindPreview: (userMessageUuid: string) => void;
  confirmRewind: () => void;
  cancelRewind: () => void;
  /** Get the SDK-assigned UUID for a user message by its stable message ID */
  getUuidForMessageId: (messageId: string) => string | undefined;
  // Message handler for transport
  handleMessage: (data: unknown) => void;
  // Dispatch function for actions
  dispatch: React.Dispatch<ChatAction>;
  // Refs for UI
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  // Connection state (passed through from transport)
  connected: boolean;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useChatState(options: UseChatStateOptions): UseChatStateReturn {
  const { dbSessionId, send, connected } = options;

  // Reducer for chat state
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialChatState);

  // Local state for input attachments (for recovery on rejection)
  const [inputAttachments, setInputAttachmentsState] = useState<MessageAttachment[]>([]);

  // Refs
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Track dbSessionId in a ref to use without stale closures
  const dbSessionIdRef = useRef<string | null>(dbSessionId ?? null);
  // Track accumulated tool input JSON per tool_use_id for streaming
  const toolInputAccumulatorRef = useRef(createToolInputAccumulatorState());
  // Track current state in a ref for stable callbacks (avoids callback recreation on state changes)
  const stateRef = useRef(state);
  stateRef.current = state;
  // Track input attachments in a ref for stable sendMessage callback
  const inputAttachmentsRef = useRef(inputAttachments);
  inputAttachmentsRef.current = inputAttachments;
  // Track rewind preview timeout for cleanup
  const rewindTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update dbSessionId ref
  useEffect(() => {
    dbSessionIdRef.current = dbSessionId;
  }, [dbSessionId]);

  // Load persisted attachments when switching sessions.
  useEffect(() => {
    setInputAttachmentsState(loadInputAttachments(dbSessionId));
  }, [dbSessionId]);

  // Update attachments and keep sessionStorage in sync.
  const setInputAttachments = useCallback((attachments: MessageAttachment[]) => {
    setInputAttachmentsState(attachments);
    persistInputAttachments(dbSessionIdRef.current, attachments);
  }, []);

  // Clear attachments from both state and persistence.
  const clearInputAttachments = useCallback(() => {
    setInputAttachmentsState([]);
    clearPersistedInputAttachments(dbSessionIdRef.current);
  }, []);

  // =============================================================================
  // Session Switching Hook
  // =============================================================================

  const { loadedDraft } = useChatSession({
    dbSessionId,
    dispatch,
    toolInputAccumulatorRef,
    sessionRuntimePhase: state.sessionRuntime.phase,
  });

  // =============================================================================
  // Persistence Hook
  // =============================================================================

  const { inputDraft, setInputDraft, clearInputDraft } = useChatPersistence({
    dbSessionId,
    initialDraft: loadedDraft,
  });

  // =============================================================================
  // Transport Hook
  // =============================================================================

  const { handleMessage } = useChatTransport({
    dispatch,
    stateRef,
    toolInputAccumulatorRef,
  });

  // =============================================================================
  // Rejected Message Recovery Effect
  // =============================================================================

  // When a message is rejected, restore the text and attachments to the input for retry
  useEffect(() => {
    if (state.lastRejectedMessage) {
      const { text, attachments } = state.lastRejectedMessage;
      // Restore the message text to the input so user can retry
      setInputDraft(text);
      // Restore attachments if present
      if (attachments && attachments.length > 0) {
        setInputAttachments(attachments);
      }
      // Clear the rejected message state after processing
      dispatch({ type: 'CLEAR_REJECTED_MESSAGE' });
    }
  }, [state.lastRejectedMessage, setInputDraft, setInputAttachments]);

  // =============================================================================
  // Action Callbacks Hook
  // =============================================================================

  const actions = useChatActions({
    send,
    dispatch,
    stateRef,
    dbSessionIdRef,
    inputAttachmentsRef,
    rewindTimeoutRef,
    onClearInput: () => {
      clearInputDraft();
      clearInputAttachments();
    },
  });

  // Clean up rewind timeout on unmount
  useEffect(() => {
    return () => {
      if (rewindTimeoutRef.current) {
        clearTimeout(rewindTimeoutRef.current);
      }
    };
  }, []);

  // =============================================================================
  // Return Value
  // =============================================================================

  // Keep return object stable between renders unless relevant state/actions change.
  return useMemo(
    () => ({
      // Spread all state from reducer
      ...state,
      // Convert queuedMessages Map to array for UI consumption
      // (Internal state uses Map for O(1) lookups and automatic de-duplication)
      queuedMessages: Array.from(state.queuedMessages.values()),
      // Connection state from transport
      connected,
      // Actions from use-chat-actions
      ...actions,
      // Additional state/actions
      inputDraft,
      setInputDraft,
      inputAttachments,
      setInputAttachments,
      // Message handler for transport (stable - no deps)
      handleMessage,
      // Dispatch function for actions
      dispatch,
      // Refs for UI
      inputRef,
      messagesEndRef,
    }),
    [
      state,
      connected,
      actions,
      inputDraft,
      setInputDraft,
      inputAttachments,
      setInputAttachments,
      handleMessage,
    ]
  );
}
