'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatMessage,
  ClaudeMessage,
  HistoryMessage,
  PermissionRequest,
  SessionInfo,
  UserQuestionRequest,
  WebSocketMessage,
} from '@/lib/claude-types';
import { convertHistoryMessage } from '@/lib/claude-types';

// =============================================================================
// Types
// =============================================================================

export interface UseChatWebSocketOptions {
  /** Claude session ID to load on connect */
  initialSessionId?: string;
}

export interface UseChatWebSocketReturn {
  // State
  messages: ChatMessage[];
  connected: boolean;
  running: boolean;
  claudeSessionId: string | null;
  availableSessions: SessionInfo[];
  // Permission request state (Phase 9)
  pendingPermission: PermissionRequest | null;
  // User question state (Phase 11)
  pendingQuestion: UserQuestionRequest | null;
  // Actions
  sendMessage: (text: string) => void;
  clearChat: () => void;
  loadSession: (claudeSessionId: string) => void;
  approvePermission: (requestId: string, allow: boolean) => void;
  answerQuestion: (requestId: string, answers: Record<string, string | string[]>) => void;
  // Refs
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

// =============================================================================
// WebSocket Message Types (outgoing)
// =============================================================================

interface StartMessage {
  type: 'start';
  workingDir?: string;
  resumeSessionId?: string;
}

interface UserInputMessage {
  type: 'user_input';
  text: string;
}

interface StopMessage {
  type: 'stop';
}

interface ListSessionsMessage {
  type: 'list_sessions';
}

interface LoadSessionMessage {
  type: 'load_session';
  claudeSessionId: string;
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

type OutgoingMessage =
  | StartMessage
  | UserInputMessage
  | StopMessage
  | ListSessionsMessage
  | LoadSessionMessage
  | PermissionResponseMessage
  | QuestionResponseMessage;

// =============================================================================
// Constants
// =============================================================================

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;
const WEBSOCKET_PORT = 3001;

// =============================================================================
// Debug Logging
// =============================================================================

const DEBUG_WEBSOCKET = true; // Set to false to disable logging

let messageCounter = 0;

function logWsMessage(direction: 'IN' | 'OUT', data: unknown): void {
  if (!DEBUG_WEBSOCKET) {
    return;
  }

  messageCounter++;
  const timestamp = new Date().toISOString();
  const prefix = direction === 'IN' ? '⬇️ WS IN' : '⬆️ WS OUT';

  console.group(`${prefix} #${messageCounter} @ ${timestamp}`);
  console.log('Raw data:', JSON.stringify(data, null, 2));

  // Extract key info for quick scanning
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    console.log('Type:', obj.type);
    if (obj.data && typeof obj.data === 'object') {
      const innerData = obj.data as Record<string, unknown>;
      console.log('Inner type:', innerData.type);
      if (innerData.type === 'assistant') {
        console.log(
          'Content blocks:',
          (innerData.message as { content?: unknown[] })?.content?.length ?? 0
        );
      }
    }
  }
  console.groupEnd();
}

// =============================================================================
// Helper Functions
// =============================================================================

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createUserMessage(text: string): ChatMessage {
  return {
    id: generateMessageId(),
    source: 'user',
    text,
    timestamp: new Date().toISOString(),
  };
}

function createClaudeMessage(message: ClaudeMessage): ChatMessage {
  return {
    id: generateMessageId(),
    source: 'claude',
    message,
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// Message Handlers
// =============================================================================

interface MessageHandlerContext {
  setRunning: (running: boolean) => void;
  setClaudeSessionId: (id: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setAvailableSessions: (sessions: SessionInfo[]) => void;
  setPendingPermission: (permission: PermissionRequest | null) => void;
  setPendingQuestion: (question: UserQuestionRequest | null) => void;
  /** Ref to track accumulated tool input JSON per tool_use_id */
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>;
  /** Updates tool input for a specific tool_use_id */
  updateToolInput: (toolUseId: string, input: Record<string, unknown>) => void;
}

function handleStatusMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  ctx.setRunning(data.running ?? false);
  if (data.claudeSessionId) {
    ctx.setClaudeSessionId(data.claudeSessionId);
  }
}

function handleStartedMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  ctx.setRunning(true);
  if (data.claudeSessionId) {
    ctx.setClaudeSessionId(data.claudeSessionId);
  }
}

/**
 * Determines if a message should be stored.
 * We filter out structural/delta events and only keep meaningful ones:
 * - content_block_start with tool_use (shows tool being used)
 * - content_block_start with tool_result (shows tool result)
 * - user messages with tool_result content (for pairing tool calls with results)
 * Skip: message_start, message_stop, message_delta, content_block_delta, content_block_stop
 */
function shouldStoreMessage(claudeMsg: ClaudeMessage): boolean {
  // User messages with tool_result content should be stored
  // These are needed to pair tool_use with tool_result in the UI
  if (claudeMsg.type === 'user') {
    const content = claudeMsg.message?.content;
    if (Array.isArray(content)) {
      return content.some(
        (item) =>
          typeof item === 'object' && item !== null && 'type' in item && item.type === 'tool_result'
      );
    }
    return false;
  }

  // Result messages are always stored
  if (claudeMsg.type === 'result') {
    return true;
  }

  // For stream events, only store meaningful ones
  if (claudeMsg.type !== 'stream_event') {
    return true; // Other non-stream events are stored
  }

  const event = (claudeMsg as { event?: { type?: string; content_block?: { type?: string } } })
    .event;
  if (!event) {
    return false;
  }

  // Only store content_block_start for tool_use and tool_result
  if (event.type === 'content_block_start' && event.content_block) {
    const blockType = event.content_block.type;
    return blockType === 'tool_use' || blockType === 'tool_result';
  }

  // Skip all other stream events (deltas, structural events, text blocks)
  return false;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: handles multiple message types with tool input streaming accumulation
function handleClaudeMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  if (data.data) {
    const claudeMsg = data.data as ClaudeMessage;

    // When we receive a 'result' message, Claude has finished the current turn
    // Set running to false so the UI no longer shows "Agent is working..."
    if (claudeMsg.type === 'result') {
      ctx.setRunning(false);
    }

    // Handle tool input accumulation from stream events
    // This needs to happen BEFORE shouldStoreMessage filtering
    if (claudeMsg.type === 'stream_event') {
      const event = (
        claudeMsg as {
          event?: {
            type?: string;
            index?: number;
            content_block?: {
              type?: string;
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            };
            delta?: { type?: string; partial_json?: string };
          };
        }
      ).event;

      // content_block_start with tool_use: Initialize accumulator
      if (
        event?.type === 'content_block_start' &&
        event.content_block?.type === 'tool_use' &&
        event.content_block.id
      ) {
        const toolUseId = event.content_block.id;
        ctx.toolInputAccumulatorRef.current.set(toolUseId, '');
        if (DEBUG_WEBSOCKET) {
          console.log('🔧 Tool use started:', toolUseId, event.content_block.name);
        }
      }

      // content_block_delta with input_json_delta: Accumulate and update
      if (
        event?.type === 'content_block_delta' &&
        event.delta?.type === 'input_json_delta' &&
        event.delta.partial_json !== undefined
      ) {
        // Find the tool_use_id by checking the most recent tool_use that hasn't completed
        // The delta events arrive for the most recently started tool_use
        const accumulatorEntries = Array.from(ctx.toolInputAccumulatorRef.current.entries());
        if (accumulatorEntries.length > 0) {
          // Get the last (most recent) tool_use_id
          const [toolUseId, currentJson] = accumulatorEntries[accumulatorEntries.length - 1];
          const newJson = currentJson + event.delta.partial_json;
          ctx.toolInputAccumulatorRef.current.set(toolUseId, newJson);

          // Try to parse the accumulated JSON and update the tool input
          try {
            const parsedInput = JSON.parse(newJson) as Record<string, unknown>;
            ctx.updateToolInput(toolUseId, parsedInput);
            if (DEBUG_WEBSOCKET) {
              console.log('🔧 Tool input updated:', toolUseId, Object.keys(parsedInput));
            }
          } catch {
            // JSON not complete yet, that's expected during streaming
          }
        }
        // Don't store delta events as messages
        return;
      }

      // content_block_stop: Clean up accumulator for this block
      if (event?.type === 'content_block_stop') {
        // We could clean up the accumulator here, but we might still need it
        // for final parsing. Clean it up when tool_result arrives instead.
      }
    }

    // Filter messages - only store meaningful ones
    if (!shouldStoreMessage(claudeMsg)) {
      if (DEBUG_WEBSOCKET) {
        const event = (claudeMsg as { event?: { type?: string } }).event;
        console.log('⏭️ Skipping message:', claudeMsg.type, event?.type);
      }
      return;
    }

    // Debug: Log when we're adding a message to state with detailed info
    if (DEBUG_WEBSOCKET) {
      const debugInfo: Record<string, unknown> = {
        type: claudeMsg.type,
      };

      // For stream events, log the event type and content block type
      if (claudeMsg.type === 'stream_event') {
        const event = (
          claudeMsg as {
            event?: { type?: string; content_block?: { type?: string; name?: string } };
          }
        ).event;
        debugInfo.eventType = event?.type;
        if (event?.content_block) {
          debugInfo.contentBlockType = event.content_block.type;
          if (event.content_block.name) {
            debugInfo.toolName = event.content_block.name;
          }
        }
      }

      // For assistant messages, log content types
      if (claudeMsg.type === 'assistant') {
        const msg = (claudeMsg as { message?: { content?: Array<{ type?: string }> } }).message;
        if (msg?.content) {
          debugInfo.contentTypes = msg.content.map((c) => c.type);
        }
      }

      console.log('📝 Adding message to state:', debugInfo);
    }

    ctx.setMessages((prev) => [...prev, createClaudeMessage(claudeMsg)]);
  }
}

function handleErrorMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  if (data.message) {
    const errorMsg: ClaudeMessage = {
      type: 'error',
      error: data.message,
      timestamp: new Date().toISOString(),
    };
    ctx.setMessages((prev) => [...prev, createClaudeMessage(errorMsg)]);
  }
}

function handleSessionsMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  if (data.sessions) {
    ctx.setAvailableSessions(data.sessions);
  }
}

function handleSessionLoadedMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  if (data.claudeSessionId) {
    ctx.setClaudeSessionId(data.claudeSessionId);
  }
  if (data.messages) {
    const historyMessages = data.messages as HistoryMessage[];
    const chatMessages = historyMessages.map(convertHistoryMessage);

    // Debug: Log session load details
    if (DEBUG_WEBSOCKET) {
      console.group('📚 Session loaded from history');
      console.log('Total messages:', chatMessages.length);
      console.log(
        'Message types:',
        chatMessages.map((m) =>
          m.source === 'user' ? 'user' : (m.message as { type?: string })?.type
        )
      );
      console.groupEnd();
    }

    ctx.setMessages(chatMessages);
  }
}

function handlePermissionRequestMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  if (data.requestId && data.toolName) {
    ctx.setPendingPermission({
      requestId: data.requestId,
      toolName: data.toolName,
      toolInput: data.toolInput ?? {},
      timestamp: new Date().toISOString(),
    });
  }
}

function handleUserQuestionMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  if (data.requestId && data.questions) {
    ctx.setPendingQuestion({
      requestId: data.requestId,
      questions: data.questions,
      timestamp: new Date().toISOString(),
    });
  }
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useChatWebSocket(options: UseChatWebSocketOptions = {}): UseChatWebSocketReturn {
  const { initialSessionId } = options;

  // State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [availableSessions, setAvailableSessions] = useState<SessionInfo[]>([]);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestionRequest | null>(null);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string>(generateSessionId());
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Store initial session ID in a ref so it's only used on first connect,
  // not when URL changes after loading a different session
  const initialSessionIdRef = useRef<string | undefined>(initialSessionId);
  const hasLoadedInitialSessionRef = useRef(false);
  // Track accumulated tool input JSON per tool_use_id for streaming
  const toolInputAccumulatorRef = useRef<Map<string, string>>(new Map());

  // Auto-scroll to bottom when messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: we want to trigger scroll on messages array change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  // Send message to WebSocket
  const sendWsMessage = useCallback((message: OutgoingMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Debug logging for outgoing messages
      logWsMessage('OUT', message);
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  // Update tool input for a specific tool_use_id in stored messages
  // This is called when we accumulate input_json_delta events
  const updateToolInput = useCallback((toolUseId: string, input: Record<string, unknown>) => {
    setMessages((prev) =>
      prev.map((msg): ChatMessage => {
        // Only update claude messages with stream events
        if (msg.source !== 'claude' || !msg.message) {
          return msg;
        }

        const claudeMsg = msg.message;

        // Check if this message is a content_block_start with matching tool_use_id
        if (
          claudeMsg.type === 'stream_event' &&
          claudeMsg.event?.type === 'content_block_start' &&
          claudeMsg.event.content_block?.type === 'tool_use' &&
          (claudeMsg.event.content_block as { id?: string }).id === toolUseId
        ) {
          // Create a new message with updated input
          // We need to deep clone and update the nested content_block.input
          const updatedEvent = {
            ...claudeMsg.event,
            content_block: {
              ...claudeMsg.event.content_block,
              input,
            },
          };

          const updatedMessage: ClaudeMessage = {
            ...claudeMsg,
            event: updatedEvent,
          };

          return {
            ...msg,
            message: updatedMessage,
          };
        }

        return msg;
      })
    );
  }, []);

  // Create handler context for message handlers
  const handlerContext: MessageHandlerContext = useMemo(
    () => ({
      setRunning,
      setClaudeSessionId,
      setMessages,
      setAvailableSessions,
      setPendingPermission,
      setPendingQuestion,
      toolInputAccumulatorRef,
      updateToolInput,
    }),
    [updateToolInput]
  );

  // Handle incoming WebSocket messages
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;

        // Debug logging for incoming messages
        logWsMessage('IN', data);

        const handlers: Record<
          string,
          (data: WebSocketMessage, ctx: MessageHandlerContext) => void
        > = {
          status: handleStatusMessage,
          started: handleStartedMessage,
          stopped: (_, ctx) => ctx.setRunning(false),
          process_exit: (_, ctx) => ctx.setRunning(false),
          claude_message: handleClaudeMessage,
          error: handleErrorMessage,
          sessions: handleSessionsMessage,
          session_loaded: handleSessionLoadedMessage,
          permission_request: handlePermissionRequestMessage,
          user_question: handleUserQuestionMessage,
        };

        const handler = handlers[data.type];
        if (handler) {
          handler(data, handlerContext);
        }
      } catch {
        // Silently ignore parse errors in production
      }
    },
    [handlerContext]
  );

  // Connect to WebSocket
  const connect = useCallback(() => {
    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Clear any pending reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    const wsUrl = `ws://${host}:${WEBSOCKET_PORT}/chat?sessionId=${sessionIdRef.current}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttemptsRef.current = 0;

      if (DEBUG_WEBSOCKET) {
        console.log('🔌 WebSocket connected to:', wsUrl);
        console.log('📊 Debug logging is ENABLED. Watch for ⬇️ IN and ⬆️ OUT messages.');
      }

      // Request list of available sessions
      sendWsMessage({ type: 'list_sessions' });

      // Load initial session only once (on first connect from URL)
      if (initialSessionIdRef.current && !hasLoadedInitialSessionRef.current) {
        hasLoadedInitialSessionRef.current = true;
        sendWsMessage({ type: 'load_session', claudeSessionId: initialSessionIdRef.current });
      }
    };

    ws.onclose = () => {
      // Only handle this close event if this WebSocket is still the current one.
      // If wsRef.current is different or null, we've already moved on to a new connection
      // and should not reconnect from this stale close event.
      if (wsRef.current !== ws) {
        if (DEBUG_WEBSOCKET) {
          console.log('🚫 Ignoring close event from replaced WebSocket');
        }
        return;
      }

      setConnected(false);
      wsRef.current = null;

      // Attempt reconnect if we haven't exceeded max attempts
      if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttemptsRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => {
      // WebSocket errors are handled by onclose
    };

    ws.onmessage = handleMessage;
  }, [handleMessage, sendWsMessage]);

  // Initialize WebSocket connection
  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // Actions
  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim()) {
        return;
      }

      // Add user message to local state
      setMessages((prev) => [...prev, createUserMessage(text)]);

      // If Claude is not running, start it first
      if (!running) {
        const startMsg: StartMessage = {
          type: 'start',
        };
        // If we have a session, resume it
        if (claudeSessionId) {
          startMsg.resumeSessionId = claudeSessionId;
        }
        sendWsMessage(startMsg);
      }

      // Send the user input
      sendWsMessage({ type: 'user_input', text });
    },
    [running, claudeSessionId, sendWsMessage]
  );

  const clearChat = useCallback(() => {
    // Stop any running Claude process
    if (running) {
      sendWsMessage({ type: 'stop' });
    }

    // Clear local state
    setMessages([]);
    setClaudeSessionId(null);
    setPendingPermission(null);
    setPendingQuestion(null);
    toolInputAccumulatorRef.current.clear();

    // Generate new session ID
    sessionIdRef.current = generateSessionId();

    // Reconnect with new session
    connect();
  }, [running, sendWsMessage, connect]);

  const loadSession = useCallback(
    (sessionId: string) => {
      sendWsMessage({ type: 'load_session', claudeSessionId: sessionId });
    },
    [sendWsMessage]
  );

  const approvePermission = useCallback(
    (requestId: string, allow: boolean) => {
      sendWsMessage({ type: 'permission_response', requestId, allow });
      setPendingPermission(null);
    },
    [sendWsMessage]
  );

  const answerQuestion = useCallback(
    (requestId: string, answers: Record<string, string | string[]>) => {
      sendWsMessage({ type: 'question_response', requestId, answers });
      setPendingQuestion(null);
    },
    [sendWsMessage]
  );

  return {
    // State
    messages,
    connected,
    running,
    claudeSessionId,
    availableSessions,
    pendingPermission,
    pendingQuestion,
    // Actions
    sendMessage,
    clearChat,
    loadSession,
    approvePermission,
    answerQuestion,
    // Refs
    inputRef,
    messagesEndRef,
  };
}
