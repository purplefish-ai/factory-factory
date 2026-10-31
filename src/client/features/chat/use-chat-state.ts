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
import { toast } from 'sonner';
import type { WebSocketSend } from '@/hooks/use-websocket-transport';
import type { ChatSettings, MessageAttachment, QueuedMessage } from '@/lib/chat-protocol';
import {
  clearInputAttachments as clearPersistedInputAttachments,
  loadInputAttachments,
  persistInputAttachments,
  persistSettings,
} from './chat-persistence';
import { type ChatAction, type ChatState, chatReducer, createInitialChatState } from './reducer';
import { reduceSettingsSlice } from './reducer/slices/settings';
import { createToolInputAccumulatorState } from './streaming-utils';
import type { SendMessageOptions } from './use-chat-actions';
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
  send: WebSocketSend;
  /** Connection state from WebSocket transport. */
  connected: boolean;
}

export interface UseChatStateReturn extends Omit<ChatState, 'queuedMessages'> {
  // Override queuedMessages to expose as array for UI consumption
  // (Internal state uses Map for O(1) lookups and automatic de-duplication)
  queuedMessages: QueuedMessage[];
  // Actions
  sendMessage: (text: string, options?: SendMessageOptions) => void;
  stopChat: () => void;
  approvePermission: (requestId: string, allow: boolean, optionId?: string) => void;
  answerQuestion: (requestId: string, answers: Record<string, string | string[]>) => void;
  updateSettings: (settings: Partial<ChatSettings>) => void;
  // Additional state/actions
  inputDraft: string;
  setInputDraft: (draft: string) => void;
  inputAttachments: MessageAttachment[];
  setInputAttachments: (attachments: MessageAttachment[]) => void;
  removeQueuedMessage: (id: string) => void;
  steerQueuedMessage: (id: string) => void;
  resumeQueuedMessages: () => void;
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
  // Roll back private command replies lost with the transport.
  handleDisconnected: () => void;
  // Dispatch function for actions
  dispatch: React.Dispatch<ChatAction>;
  // Refs for UI
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  // Connection state (passed through from transport)
  connected: boolean;
}

function showAttachmentPersistenceError(operation: 'save' | 'clear') {
  if (operation === 'save') {
    toast.error('Attachments were not autosaved', {
      description:
        'They are still in this composer, but may be lost if you reload or switch sessions.',
    });
    return;
  }

  toast.error('Saved attachments could not be cleared', {
    description: 'Previously saved attachments may reappear after a reload or session switch.',
  });
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

  // Use an identity token so callbacks from an earlier visit to the same session
  // also expire when switching away and back.
  const sessionContextRef = useRef({ dbSessionId });
  if (sessionContextRef.current.dbSessionId !== dbSessionId) {
    sessionContextRef.current = { dbSessionId };
  }
  const sessionContext = sessionContextRef.current;
  dbSessionIdRef.current = dbSessionId;

  const handleDisconnected = useCallback(() => {
    if (sessionContextRef.current !== sessionContext) {
      return;
    }
    // Private command replies can be lost with the socket. Reconnect snapshots
    // must regain authority instead of retaining an unacknowledged selection.
    const action: ChatAction = { type: 'CONFIG_OPTIONS_DISCONNECTED' };
    const previousSettings = stateRef.current.chatSettings;
    stateRef.current = reduceSettingsSlice(stateRef.current, action);
    dispatch(action);
    if (stateRef.current.chatSettings !== previousSettings) {
      persistSettings(dbSessionIdRef.current, stateRef.current.chatSettings);
    }
  }, [sessionContext]);

  const wasConnectedRef = useRef(connected);
  useEffect(() => {
    if (wasConnectedRef.current && !connected) {
      handleDisconnected();
    }
    wasConnectedRef.current = connected;
  }, [connected, handleDisconnected]);

  // Load persisted attachments when switching sessions.
  useEffect(() => {
    setInputAttachmentsState(loadInputAttachments(dbSessionId));
  }, [dbSessionId]);

  // Update attachments and keep sessionStorage in sync.
  const setInputAttachments = useCallback((attachments: MessageAttachment[]) => {
    setInputAttachmentsState(attachments);
    const persistenceResult = persistInputAttachments(dbSessionIdRef.current, attachments);
    if (!persistenceResult.ok) {
      showAttachmentPersistenceError(persistenceResult.operation);
    }
  }, []);

  // Clear attachments from both state and persistence.
  const clearInputAttachments = useCallback(() => {
    setInputAttachmentsState([]);
    const persistenceResult = clearPersistedInputAttachments(dbSessionIdRef.current);
    if (!persistenceResult.ok) {
      showAttachmentPersistenceError(persistenceResult.operation);
    }
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

  // Keep clear-input callback stable so action callbacks (for example sendMessage)
  // are not recreated on each render.
  const onClearInput = useCallback(() => {
    clearInputDraft();
    clearInputAttachments();
  }, [clearInputDraft, clearInputAttachments]);

  // =============================================================================
  // Transport Hook
  // =============================================================================

  // Settings confirmations and rollbacks must be visible to an immediate send,
  // including multiple transport events batched before React commits a render.
  const dispatchTransportAction = useCallback((action: ChatAction) => {
    const previousState = stateRef.current;
    const nextState = reduceSettingsSlice(previousState, action);
    if (nextState !== previousState) {
      stateRef.current = nextState;
      if (nextState.chatSettings !== previousState.chatSettings) {
        persistSettings(dbSessionIdRef.current, nextState.chatSettings);
      }
    }
    dispatch(action);
  }, []);

  const { handleMessage: handleTransportMessage } = useChatTransport({
    dispatch: dispatchTransportAction,
    stateRef,
    toolInputAccumulatorRef,
  });

  // Transport callbacks captured by a previous session cannot mutate this session.
  const handleMessage = useCallback(
    (data: unknown) => {
      if (sessionContextRef.current === sessionContext) {
        handleTransportMessage(data);
      }
    },
    [sessionContext, handleTransportMessage]
  );

  // =============================================================================
  // Rejected Message Recovery Effect
  // =============================================================================

  // When a message is rejected, restore the text and attachments to the input for retry
  useEffect(() => {
    if (state.lastRejectedMessage) {
      const { text, attachments, sessionId } = state.lastRejectedMessage;
      if (
        !sessionId ||
        sessionId !== dbSessionIdRef.current ||
        inputDraft.length > 0 ||
        inputAttachmentsRef.current.length > 0
      ) {
        dispatch({ type: 'CLEAR_REJECTED_MESSAGE' });
        return;
      }
      // Restore only into an empty composer so delayed failures preserve newer drafts.
      setInputDraft(text);
      // Restore attachments if present
      if (attachments && attachments.length > 0) {
        setInputAttachments(attachments);
      }
      // Clear the rejected message state after processing
      dispatch({ type: 'CLEAR_REJECTED_MESSAGE' });
    }
  }, [state.lastRejectedMessage, inputDraft, setInputDraft, setInputAttachments]);

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
    onClearInput,
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

  // Derive these only when their sources change. Streamed events replace `state`
  // on every token, and fresh arrays here would re-render memoized consumers.
  const acpConfigOptions = useMemo(
    () =>
      state.acpConfigOptions?.map((option) => ({
        ...option,
        currentValue:
          option.id === 'model' || option.category === 'model'
            ? option.currentValue
            : (state.pendingConfigOptions.get(option.id)?.value ?? option.currentValue),
      })) ?? null,
    [state.acpConfigOptions, state.pendingConfigOptions]
  );
  // Convert queuedMessages Map to array for UI consumption
  // (Internal state uses Map for O(1) lookups and automatic de-duplication)
  const queuedMessages = useMemo(
    () => Array.from(state.queuedMessages.values()),
    [state.queuedMessages]
  );

  // Keep return object stable between renders unless relevant state/actions change.
  return useMemo(
    () => ({
      // Spread all state from reducer
      ...state,
      acpConfigOptions,
      queuedMessages,
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
      handleDisconnected,
      // Dispatch function for actions
      dispatch,
      // Refs for UI
      inputRef,
    }),
    [
      state,
      acpConfigOptions,
      queuedMessages,
      connected,
      actions,
      inputDraft,
      setInputDraft,
      inputAttachments,
      setInputAttachments,
      handleMessage,
      handleDisconnected,
    ]
  );
}
