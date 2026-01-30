'use client';

/**
 * Chat state management hook using the chat reducer and persistence modules.
 *
 * This hook manages:
 * - Chat state via useReducer (messages, running state, permissions, etc.)
 * - Session persistence (settings, drafts, message queue)
 * - WebSocket message handling (converts to reducer actions)
 * - Action callbacks for UI (sendMessage, stopChat, etc.)
 * - Message queue draining when agent becomes idle
 * - Session switching effects
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
  ChatMessage,
  ChatSettings,
  ClaudeMessage,
  QueuedMessage,
  WebSocketMessage,
} from '@/lib/claude-types';
import { DEFAULT_CHAT_SETTINGS, THINKING_SUFFIX } from '@/lib/claude-types';
import { createDebugLogger } from '@/lib/debug';
import {
  clearDraft,
  loadAllSessionData,
  loadSettings,
  persistDraft,
  persistQueue,
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

interface StartMessage {
  type: 'start';
  workingDir?: string;
  selectedModel?: string | null;
  thinkingEnabled?: boolean;
  planModeEnabled?: boolean;
}

interface StopMessage {
  type: 'stop';
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

function createUserMessage(text: string): ChatMessage {
  return {
    id: generateMessageId(),
    source: 'user',
    text,
    timestamp: new Date().toISOString(),
  };
}

// Type for stream event structure
interface StreamEventData {
  type?: string;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
  };
  delta?: { type?: string; partial_json?: string };
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

  // Refs
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Track dbSessionId in a ref to use without stale closures
  const dbSessionIdRef = useRef<string | null>(dbSessionId ?? null);
  // Track previous dbSessionId to detect session switches
  const prevDbSessionIdRef = useRef<string | null>(null);
  // Track previous running state to detect idle transitions
  const prevRunningRef = useRef(false);
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

      // Persist queue clear for the old session to prevent stale messages on refresh
      persistQueue(prevDbSessionId, []);

      // Dispatch session switch to reset reducer state
      dispatch({ type: 'SESSION_SWITCH_START' });

      // Clear tool input accumulator
      toolInputAccumulatorRef.current.clear();
    }

    // Load persisted data for the new session
    if (newDbSessionId) {
      const persistedData = loadAllSessionData(newDbSessionId);
      setInputDraftState(persistedData.draft);
      dispatch({ type: 'SET_SETTINGS', payload: persistedData.settings });
      dispatch({ type: 'SET_QUEUE', payload: persistedData.queue });

      // Set loading state for initial load (when prevDbSessionId was null)
      // This prevents "No messages yet" flash while WebSocket connects and loads session
      // For session switches, SESSION_SWITCH_START already set loadingSession: true
      if (prevDbSessionId === null) {
        dispatch({ type: 'SESSION_LOADING_START' });
      }
    } else {
      setInputDraftState('');
      dispatch({ type: 'SET_SETTINGS', payload: DEFAULT_CHAT_SETTINGS });
      dispatch({ type: 'SET_QUEUE', payload: [] });
    }
  }, [dbSessionId]);

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
  // Queue Draining
  // =============================================================================

  // Drain next message from queue and send to Claude
  // Uses stateRef to access current state without recreating callback on state changes
  const drainQueue = useCallback(() => {
    const { running, startingSession, queuedMessages, chatSettings } = stateRef.current;

    if (running || startingSession || queuedMessages.length === 0) {
      return;
    }

    const [nextMsg, ...remaining] = queuedMessages;

    // Update queue in state
    dispatch({ type: 'SET_QUEUE', payload: remaining });
    persistQueue(dbSessionIdRef.current, remaining);

    // Clear draft when sending a message
    setInputDraftState('');
    clearDraft(dbSessionIdRef.current);

    // Add to messages (optimistic UI)
    dispatch({ type: 'USER_MESSAGE_SENT', payload: createUserMessage(nextMsg.text) });

    // Start Claude if not running
    dispatch({ type: 'WS_STARTING' });
    const startMsg: StartMessage = {
      type: 'start',
      selectedModel: chatSettings.selectedModel,
      thinkingEnabled: chatSettings.thinkingEnabled,
      planModeEnabled: chatSettings.planModeEnabled,
    };
    send(startMsg);

    // Send the user input
    const messageToSend = chatSettings.thinkingEnabled
      ? `${nextMsg.text}${THINKING_SUFFIX}`
      : nextMsg.text;
    send({ type: 'user_input', text: messageToSend });
  }, [send]);

  // Drain queue when agent becomes idle
  // Destructure state values for cleaner logic
  const { running, startingSession, queuedMessages } = state;

  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    const isNowIdle = !(running || startingSession);
    const becameIdle = wasRunning && isNowIdle;
    const hasQueuedMessages = queuedMessages.length > 0;

    // Update ref for next render
    prevRunningRef.current = running;

    // Only drain if we just became idle, or if we're already idle and have messages
    if ((becameIdle || isNowIdle) && hasQueuedMessages) {
      drainQueue();
    }
  }, [running, startingSession, queuedMessages.length, drainQueue]);

  // =============================================================================
  // Action Callbacks
  // =============================================================================

  const sendMessage = useCallback((text: string) => {
    if (!text.trim()) {
      return;
    }

    const queuedMsg: QueuedMessage = {
      id: generateMessageId(),
      text: text.trim(),
      timestamp: new Date().toISOString(),
    };

    dispatch({ type: 'QUEUE_MESSAGE', payload: queuedMsg });
    persistQueue(dbSessionIdRef.current, [...stateRef.current.queuedMessages, queuedMsg]);
  }, []);

  const stopChat = useCallback(() => {
    const { running, stopping } = stateRef.current;
    if (running && !stopping) {
      dispatch({ type: 'STOP_REQUESTED' });
      send({ type: 'stop' } as StopMessage);
    }
  }, [send]);

  const clearChat = useCallback(() => {
    // Stop any running Claude process
    if (stateRef.current.running) {
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
      const msg: PermissionResponseMessage = { type: 'permission_response', requestId, allow };
      send(msg);
      dispatch({ type: 'PERMISSION_RESPONSE' });
    },
    [send]
  );

  const answerQuestion = useCallback(
    (requestId: string, answers: Record<string, string | string[]>) => {
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

  const removeQueuedMessage = useCallback((id: string) => {
    dispatch({ type: 'REMOVE_QUEUED_MESSAGE', payload: { id } });
    const updated = stateRef.current.queuedMessages.filter((msg) => msg.id !== id);
    persistQueue(dbSessionIdRef.current, updated);
  }, []);

  // Debounce sessionStorage persistence to avoid blocking on every keystroke
  const persistDraftDebounced = useRef<ReturnType<typeof setTimeout>>();

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
