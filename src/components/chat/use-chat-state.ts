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
 * receives queue events (message_queued, message_dispatched, message_removed).
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
import type {
  ChatSettings,
  ClaudeMessage,
  MessageAttachment,
  WebSocketMessage,
} from '@/lib/claude-types';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/claude-types';
import { createDebugLogger } from '@/lib/debug';
import {
  clearDraft,
  loadAllSessionData,
  loadSettings,
  persistDraft,
  persistSettings,
} from './chat-persistence';
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  createActionFromWebSocketMessage,
  createInitialChatState,
} from './chat-reducer';

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

export interface UseChatStateReturn extends ChatState {
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

interface StopMessage {
  type: 'stop';
}

interface QueueMessageRequest {
  type: 'queue_message';
  id: string;
  text: string;
  attachments?: MessageAttachment[];
  settings: {
    selectedModel: string | null;
    thinkingEnabled: boolean;
    planModeEnabled: boolean;
  };
}

interface RemoveQueuedMessageRequest {
  type: 'remove_queued_message';
  messageId: string;
}

interface PermissionResponseMessage {
  type: 'permission_response';
  requestId: string;
  allow: boolean;
}

interface QuestionResponseMessage {
  type: 'question_response';
  requestId: string;
  answers: Record<string, string | string[]>;
}

// =============================================================================
// Helper Functions
// =============================================================================

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Type for stream event structure
interface StreamEventData {
  type?: string;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
  };
  delta?: { type?: string; partial_json?: string; thinking?: string };
}

/**
 * Get stream event data from a Claude message.
 */
function getStreamEvent(claudeMsg: ClaudeMessage): StreamEventData | null {
  if (claudeMsg.type !== 'stream_event') {
    return null;
  }
  return (claudeMsg as { event?: StreamEventData }).event ?? null;
}

/**
 * Handle tool_use block start - initialize accumulator.
 */
function handleToolUseStart(
  event: StreamEventData,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>
): void {
  if (
    event.type === 'content_block_start' &&
    event.content_block?.type === 'tool_use' &&
    event.content_block.id
  ) {
    const toolUseId = event.content_block.id;
    toolInputAccumulatorRef.current.set(toolUseId, '');
    debug.log('Tool use started:', toolUseId, event.content_block.name);
  }
}

/**
 * Handle tool input JSON delta - accumulate and try to parse.
 * Returns a TOOL_INPUT_UPDATE action if valid JSON was accumulated, null otherwise.
 */
function handleToolInputDelta(
  event: StreamEventData,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>
): ChatAction | null {
  if (
    event.type !== 'content_block_delta' ||
    event.delta?.type !== 'input_json_delta' ||
    event.delta.partial_json === undefined
  ) {
    return null;
  }

  const accumulatorEntries = Array.from(toolInputAccumulatorRef.current.entries());
  if (accumulatorEntries.length === 0) {
    return null;
  }

  // Get the last (most recent) tool_use_id
  const [toolUseId, currentJson] = accumulatorEntries[accumulatorEntries.length - 1];
  const newJson = currentJson + event.delta.partial_json;
  toolInputAccumulatorRef.current.set(toolUseId, newJson);

  // Try to parse the accumulated JSON and create update action
  try {
    const parsedInput = JSON.parse(newJson) as Record<string, unknown>;
    debug.log('Tool input updated:', toolUseId, Object.keys(parsedInput));
    return { type: 'TOOL_INPUT_UPDATE', payload: { toolUseId, input: parsedInput } };
  } catch {
    // JSON not complete yet, that's expected during streaming
    return null;
  }
}

/**
 * Handle tool input accumulation from stream events.
 * Returns a TOOL_INPUT_UPDATE action if input was accumulated, null otherwise.
 */
function handleToolInputStreaming(
  claudeMsg: ClaudeMessage,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>
): ChatAction | null {
  const event = getStreamEvent(claudeMsg);
  if (!event) {
    return null;
  }

  // Initialize accumulator for tool_use start events
  handleToolUseStart(event, toolInputAccumulatorRef);

  // Handle input JSON deltas
  return handleToolInputDelta(event, toolInputAccumulatorRef);
}

/**
 * Handle thinking delta stream events (extended thinking mode).
 * Returns a THINKING_DELTA action for thinking deltas, THINKING_CLEAR for message_start, null otherwise.
 */
function handleThinkingStreaming(claudeMsg: ClaudeMessage): ChatAction | null {
  const event = getStreamEvent(claudeMsg);
  if (!event) {
    return null;
  }

  // Clear thinking on new message start
  if (event.type === 'message_start') {
    return { type: 'THINKING_CLEAR' };
  }

  // Accumulate thinking delta
  if (
    event.type === 'content_block_delta' &&
    event.delta?.type === 'thinking_delta' &&
    event.delta.thinking
  ) {
    return { type: 'THINKING_DELTA', payload: { thinking: event.delta.thinking } };
  }

  return null;
}

/**
 * Handle session_loaded message with settings override logic.
 * Prefers locally stored settings over backend-inferred settings.
 */
function handleSessionLoaded(
  wsMessage: WebSocketMessage,
  dbSessionIdRef: React.MutableRefObject<string | null>,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>,
  dispatch: React.Dispatch<ChatAction>
): void {
  // Dispatch the main session loaded action
  const action = createActionFromWebSocketMessage(wsMessage);
  if (action) {
    dispatch(action);
  }

  // Handle settings: prefer locally stored settings over backend-inferred
  if (wsMessage.settings) {
    const sessionId = dbSessionIdRef.current;
    const storedSettings = sessionId ? loadSettings(sessionId) : null;
    if (storedSettings) {
      // User has explicit settings stored - use those
      dispatch({ type: 'SET_SETTINGS', payload: storedSettings });
    } else {
      // No stored settings - use backend settings and persist them
      dispatch({ type: 'SET_SETTINGS', payload: wsMessage.settings });
      if (sessionId) {
        persistSettings(sessionId, wsMessage.settings);
      }
    }
  }

  // Clear tool input accumulator when loading a new session
  toolInputAccumulatorRef.current.clear();
}

/**
 * Handle Claude message with tool input streaming.
 */
function handleClaudeMessageWithStreaming(
  wsMessage: WebSocketMessage,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>,
  dispatch: React.Dispatch<ChatAction>
): void {
  if (!wsMessage.data) {
    return;
  }

  const claudeMsg = wsMessage.data as ClaudeMessage;

  // Handle tool input streaming before the main action
  const toolInputAction = handleToolInputStreaming(claudeMsg, toolInputAccumulatorRef);
  if (toolInputAction) {
    dispatch(toolInputAction);
    // Don't return - still need to dispatch the main action for content_block_start
  }

  // Handle thinking streaming (extended thinking mode)
  const thinkingAction = handleThinkingStreaming(claudeMsg);
  if (thinkingAction) {
    dispatch(thinkingAction);
    // Don't return - THINKING_CLEAR also needs the main action to process
  }
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

  // =============================================================================
  // Session Switching Effect
  // =============================================================================

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

    // Load persisted data for the new session (queue comes from backend via session_loaded)
    if (newDbSessionId) {
      const persistedData = loadAllSessionData(newDbSessionId);
      setInputDraftState(persistedData.draft);
      dispatch({ type: 'SET_SETTINGS', payload: persistedData.settings });
      // Queue is loaded from backend via session_loaded message, not from frontend persistence

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

  // =============================================================================
  // WebSocket Message Handler
  // =============================================================================

  const handleMessage = useCallback(
    (data: unknown) => {
      const wsMessage = data as WebSocketMessage;

      // Handle Claude messages specially for tool input streaming
      if (wsMessage.type === 'claude_message') {
        handleClaudeMessageWithStreaming(wsMessage, toolInputAccumulatorRef, dispatch);
      }

      // Handle session_loaded specially for settings override
      if (wsMessage.type === 'session_loaded') {
        handleSessionLoaded(wsMessage, dbSessionIdRef, toolInputAccumulatorRef, dispatch);
        return;
      }

      // Convert WebSocket message to action and dispatch
      const action = createActionFromWebSocketMessage(wsMessage);
      if (action) {
        dispatch(action);
      }
    },
    [] // No dependencies - uses refs for session ID
  );

  // =============================================================================
  // Action Callbacks
  // =============================================================================

  const sendMessage = useCallback(
    (text: string, attachments?: MessageAttachment[]) => {
      const trimmedText = text.trim();
      if (!trimmedText && (!attachments || attachments.length === 0)) {
        return;
      }

      // Generate single ID for tracking
      const id = generateMessageId();

      // Mark message as pending backend confirmation (shows "sending..." indicator)
      // Store text and attachments for recovery if message is rejected
      dispatch({ type: 'MESSAGE_SENDING', payload: { id, text: trimmedText, attachments } });

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
        attachments,
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

  const updateSettings = useCallback((settings: Partial<ChatSettings>) => {
    dispatch({ type: 'UPDATE_SETTINGS', payload: settings });
    // Persist updated settings
    const newSettings = { ...stateRef.current.chatSettings, ...settings };
    persistSettings(dbSessionIdRef.current, newSettings);
  }, []);

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

  // Clean up pending debounced persist on unmount to prevent stale writes
  useEffect(() => {
    return () => {
      if (persistDraftDebounced.current) {
        clearTimeout(persistDraftDebounced.current);
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
      handleMessage,
    ]
  );
}
