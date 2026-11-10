/**
 * Chat state management hook using the chat reducer and persistence modules.
 *
 * This hook manages:
 * - Chat state via useReducer (messages, running state, permissions, etc.)
 * - Session persistence (settings here; drafts and attachments in useChatPersistence)
 * - WebSocket message handling (converts to reducer actions)
 * - Action callbacks for UI (sendMessage, stopChat, etc.)
 * - Session switching (useChatPersistence while rendering, useChatSession after commit)
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

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useLatestRef } from '@/client/hooks/use-stable-callback';
import type { WebSocketSend } from '@/hooks/use-websocket-transport';
import type {
  ChatSettings,
  MessageAttachment,
  QueuedMessage,
  WebSocketMessage,
} from '@/lib/chat-protocol';
import { persistSettings } from './chat-persistence';
import { type ChatAction, type ChatState, chatReducer, createInitialChatState } from './reducer';
import { reduceSettingsSlice } from './reducer/slices/settings';
import { useStreamDeltaCoalescedDispatch } from './stream-delta-coalescer';
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
  inputDraftGeneration: number;
  setInputAttachments: (attachments: React.SetStateAction<MessageAttachment[]>) => void;
  removeQueuedMessage: (id: string) => void;
  steerQueuedMessage: (id: string) => void;
  resumeQueuedMessages: () => void;
  // ACP config option action
  setConfigOption: (configId: string, value: string) => void;
  // Message handler for transport
  // Handles a frame already validated by `parseChatServerMessage`.
  handleMessage: (message: WebSocketMessage) => void;
  // Roll back private command replies lost with the transport.
  handleDisconnected: () => void;
  // Dispatch function for actions
  dispatch: React.Dispatch<ChatAction>;
  // Refs for UI
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  // Connection state (passed through from transport)
  connected: boolean;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useChatState(options: UseChatStateOptions): UseChatStateReturn {
  const { dbSessionId, send, connected } = options;

  // Reducer for chat state. Every dispatch goes through the coalescer, so
  // stream deltas buffered in the current window reach the reducer before any
  // later action, including session switches, disconnects and user sends.
  const [state, reducerDispatch] = useReducer(chatReducer, undefined, createInitialChatState);
  const dispatch = useStreamDeltaCoalescedDispatch(reducerDispatch);

  // The composer switches sessions while rendering. Its visit identifies this
  // selection, so callbacks from an earlier visit to the same session also expire.
  const {
    visit: sessionContext,
    inputDraft,
    setInputDraft,
    inputAttachments,
    inputAttachmentsRef,
    inputDraftGeneration,
    setInputAttachments,
    clearInput: onClearInput,
  } = useChatPersistence(dbSessionId);

  const sessionContextRef = useLatestRef(sessionContext);

  // Refs
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Latest committed values for stable callbacks. Handlers may write the state
  // they are about to commit, so a second call in the same event sees it.
  const dbSessionIdRef = useLatestRef(dbSessionId);
  const stateRef = useLatestRef(state);
  // Track accumulated tool input JSON per tool_use_id for streaming
  const toolInputAccumulatorRef = useRef(createToolInputAccumulatorState());

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
  }, [dispatch, sessionContext]);

  const wasConnectedRef = useRef(connected);
  useEffect(() => {
    if (wasConnectedRef.current && !connected) {
      handleDisconnected();
    }
    wasConnectedRef.current = connected;
  }, [connected, handleDisconnected]);

  // =============================================================================
  // Session Switching Hook
  // =============================================================================

  useChatSession({
    dbSessionId,
    dispatch,
    toolInputAccumulatorRef,
    sessionRuntimePhase: state.sessionRuntime.phase,
  });

  // =============================================================================
  // Transport Hook
  // =============================================================================

  // Settings confirmations and rollbacks must be visible to an immediate send,
  // including multiple transport events batched before React commits a render.
  const dispatchTransportAction = useCallback(
    (action: ChatAction) => {
      const previousState = stateRef.current;
      const nextState = reduceSettingsSlice(previousState, action);
      if (nextState !== previousState) {
        stateRef.current = nextState;
        if (nextState.chatSettings !== previousState.chatSettings) {
          persistSettings(dbSessionIdRef.current, nextState.chatSettings);
        }
      }
      dispatch(action);
    },
    [dispatch]
  );

  const { handleMessage: handleTransportMessage } = useChatTransport({
    dispatch: dispatchTransportAction,
    stateRef,
    toolInputAccumulatorRef,
  });

  // Transport callbacks captured by a previous session cannot mutate this session.
  const handleMessage = useCallback(
    (message: WebSocketMessage) => {
      if (sessionContextRef.current === sessionContext) {
        handleTransportMessage(message);
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
        inputAttachments.length > 0
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
  }, [
    dispatch,
    state.lastRejectedMessage,
    inputDraft,
    inputAttachments,
    setInputDraft,
    setInputAttachments,
  ]);

  // =============================================================================
  // Action Callbacks Hook
  // =============================================================================

  const actions = useChatActions({
    send,
    dispatch,
    stateRef,
    dbSessionIdRef,
    inputAttachmentsRef,
    onClearInput,
  });

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

  return {
    ...state,
    acpConfigOptions,
    queuedMessages,
    connected,
    ...actions,
    inputDraft,
    setInputDraft,
    inputAttachments,
    inputDraftGeneration,
    setInputAttachments,
    handleMessage,
    handleDisconnected,
    dispatch,
    inputRef,
  };
}
