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

function handleClaudeMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  if (data.data) {
    const claudeMsg = data.data as ClaudeMessage;

    // When we receive a 'result' message, Claude has finished the current turn
    // Set running to false so the UI no longer shows "Agent is working..."
    if (claudeMsg.type === 'result') {
      ctx.setRunning(false);
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
      wsRef.current.send(JSON.stringify(message));
    }
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
    }),
    []
  );

  // Handle incoming WebSocket messages
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;

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

      // Request list of available sessions
      sendWsMessage({ type: 'list_sessions' });

      // Load initial session only once (on first connect from URL)
      if (initialSessionIdRef.current && !hasLoadedInitialSessionRef.current) {
        hasLoadedInitialSessionRef.current = true;
        sendWsMessage({ type: 'load_session', claudeSessionId: initialSessionIdRef.current });
      }
    };

    ws.onclose = () => {
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
