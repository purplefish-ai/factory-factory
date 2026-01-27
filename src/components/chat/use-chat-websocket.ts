'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatMessage,
  ChatSettings,
  ClaudeMessage,
  HistoryMessage,
  PermissionRequest,
  SessionInfo,
  UserQuestionRequest,
  WebSocketMessage,
} from '@/lib/claude-types';
import { convertHistoryMessage, DEFAULT_CHAT_SETTINGS, THINKING_SUFFIX } from '@/lib/claude-types';
import { createDebugLogger } from '@/lib/debug';
import {
  buildWebSocketUrl,
  getReconnectDelay,
  MAX_RECONNECT_ATTEMPTS,
} from '@/lib/websocket-config';

// =============================================================================
// Types
// =============================================================================

export interface UseChatWebSocketOptions {
  /** Claude CLI session ID to load on connect (stored in ~/.claude/projects/) */
  initialClaudeSessionId?: string;
  /** Working directory for Claude CLI (workspace worktree path) */
  workingDir?: string;
  /**
   * Database session ID (required).
   * This is the primary key for the ClaudeSession record.
   * Must be provided before connecting - the hook will not connect without it.
   */
  dbSessionId: string | null;
}

export interface UseChatWebSocketReturn {
  // State
  messages: ChatMessage[];
  connected: boolean;
  running: boolean;
  claudeSessionId: string | null;
  gitBranch: string | null;
  availableSessions: SessionInfo[];
  // Permission request state (Phase 9)
  pendingPermission: PermissionRequest | null;
  // User question state (Phase 11)
  pendingQuestion: UserQuestionRequest | null;
  // Session loading state
  loadingSession: boolean;
  // Session starting state (Claude CLI is spinning up)
  startingSession: boolean;
  // Chat settings
  chatSettings: ChatSettings;
  // Actions
  sendMessage: (text: string) => void;
  stopChat: () => void;
  clearChat: () => void;
  loadSession: (claudeSessionId: string) => void;
  approvePermission: (requestId: string, allow: boolean) => void;
  answerQuestion: (requestId: string, answers: Record<string, string | string[]>) => void;
  updateSettings: (settings: Partial<ChatSettings>) => void;
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
  selectedModel?: string | null;
  thinkingEnabled?: boolean;
  planModeEnabled?: boolean;
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
// Debug Logging
// =============================================================================

const DEBUG_WEBSOCKET = false;
const debug = createDebugLogger(DEBUG_WEBSOCKET);

/**
 * Maximum number of messages to queue while disconnected.
 */
const MAX_QUEUE_SIZE = 100;

/**
 * Maximum number of queued messages to send per flush to avoid overwhelming the server.
 * Remaining messages will be sent on subsequent flushes.
 */
const MAX_FLUSH_BATCH_SIZE = 10;

/**
 * Message types that are time-sensitive and should not be queued/replayed after reconnect.
 * These commands only make sense in the context of an active session at the time they were sent.
 */
const STALE_MESSAGE_TYPES = new Set(['stop', 'interrupt']);

function logWsMessage(
  direction: 'IN' | 'OUT' | 'OUT (queued)',
  data: unknown,
  counter: number
): void {
  if (!DEBUG_WEBSOCKET) {
    return;
  }

  const timestamp = new Date().toISOString();
  const prefix =
    direction === 'IN'
      ? '⬇️ WS IN'
      : direction === 'OUT (queued)'
        ? '⬆️ WS OUT (queued)'
        : '⬆️ WS OUT';

  debug.group(`${prefix} #${counter} @ ${timestamp}`);
  debug.log('Raw data:', JSON.stringify(data, null, 2));

  // Extract key info for quick scanning
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    debug.log('Type:', obj.type);
    if (obj.data && typeof obj.data === 'object') {
      const innerData = obj.data as Record<string, unknown>;
      debug.log('Inner type:', innerData.type);
      if (innerData.type === 'assistant') {
        debug.log(
          'Content blocks:',
          (innerData.message as { content?: unknown[] })?.content?.length ?? 0
        );
      }
    }
  }
  debug.groupEnd();
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
  setGitBranch: (branch: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setAvailableSessions: (sessions: SessionInfo[]) => void;
  setPendingPermission: (permission: PermissionRequest | null) => void;
  setPendingQuestion: (question: UserQuestionRequest | null) => void;
  setLoadingSession: (loading: boolean) => void;
  setStartingSession: (starting: boolean) => void;
  setChatSettings: (settings: ChatSettings) => void;
  /** Ref to track accumulated tool input JSON per tool_use_id */
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>;
  /** Updates tool input for a specific tool_use_id */
  updateToolInput: (toolUseId: string, input: Record<string, unknown>) => void;
  /** Ref to track which Claude CLI session has been successfully loaded */
  loadedClaudeSessionIdRef: React.MutableRefObject<string | null>;
}

function handleStatusMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  ctx.setRunning(data.running ?? false);
  if (data.claudeSessionId) {
    ctx.setClaudeSessionId(data.claudeSessionId);
  }
}

function handleStartingMessage(_data: WebSocketMessage, ctx: MessageHandlerContext): void {
  ctx.setStartingSession(true);
}

function handleStartedMessage(data: WebSocketMessage, ctx: MessageHandlerContext): void {
  ctx.setStartingSession(false);
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

    // If we receive a Claude message, we're clearly past the starting phase
    ctx.setStartingSession(false);

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
        debug.log('🔧 Tool use started:', toolUseId, event.content_block.name);
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
            debug.log('🔧 Tool input updated:', toolUseId, Object.keys(parsedInput));
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
      const event = (claudeMsg as { event?: { type?: string } }).event;
      debug.log('⏭️ Skipping message:', claudeMsg.type, event?.type);
      return;
    }

    // Debug: Log when we're adding a message to state with detailed info
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

    debug.log('📝 Adding message to state:', debugInfo);

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
    // Track that this Claude CLI session has been successfully loaded
    ctx.loadedClaudeSessionIdRef.current = data.claudeSessionId;
  }
  // Set git branch (may be null if session doesn't have branch info)
  ctx.setGitBranch(data.gitBranch ?? null);
  if (data.messages) {
    const historyMessages = data.messages as HistoryMessage[];
    const chatMessages = historyMessages.map(convertHistoryMessage);

    // Debug: Log session load details
    debug.group('📚 Session loaded from history');
    debug.log('Total messages:', chatMessages.length);
    debug.log('Git branch:', data.gitBranch);
    debug.log(
      'Message types:',
      chatMessages.map((m) =>
        m.source === 'user' ? 'user' : (m.message as { type?: string })?.type
      )
    );
    debug.groupEnd();

    ctx.setMessages(chatMessages);
    // Clear tool input accumulator when loading a new session to prevent memory buildup
    ctx.toolInputAccumulatorRef.current.clear();
  }
  // Load settings if present
  if (data.settings) {
    ctx.setChatSettings(data.settings);
  }
  ctx.setLoadingSession(false);
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

function handleMessageQueuedMessage(data: WebSocketMessage, _ctx: MessageHandlerContext): void {
  // Message was queued on backend, waiting for Claude process to start
  // The user message is already in local state (optimistic UI), so just log
  debug.log('📥 Message queued on backend:', data.text);
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useChatWebSocket(options: UseChatWebSocketOptions): UseChatWebSocketReturn {
  const { initialClaudeSessionId, workingDir, dbSessionId } = options;

  // State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [availableSessions, setAvailableSessions] = useState<SessionInfo[]>([]);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestionRequest | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [startingSession, setStartingSession] = useState(false);
  const [chatSettings, setChatSettings] = useState<ChatSettings>(DEFAULT_CHAT_SETTINGS);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  // Unique connection ID for this browser window (stable across reconnects)
  const connectionIdRef = useRef<string>(
    `conn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  );
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Store initial Claude CLI session ID in a ref so it's only used on first connect,
  // not when URL changes after loading a different session
  const initialClaudeSessionIdRef = useRef<string | null>(initialClaudeSessionId ?? null);
  const hasLoadedInitialSessionRef = useRef(false);
  // Track dbSessionId in a ref to use in connect without stale closures
  const dbSessionIdRef = useRef<string | null>(dbSessionId ?? null);
  // Track previous dbSessionId to detect session switches
  const prevDbSessionIdRef = useRef<string | null>(null);
  // Track which Claude CLI session ID has been successfully loaded (via URL or picker)
  const loadedClaudeSessionIdRef = useRef<string | null>(null);
  // Track accumulated tool input JSON per tool_use_id for streaming
  const toolInputAccumulatorRef = useRef<Map<string, string>>(new Map());
  // Debug message counter (instance-scoped, not global)
  const messageCounterRef = useRef(0);
  // Message queue for messages sent while disconnected
  const messageQueueRef = useRef<OutgoingMessage[]>([]);
  // Track current claudeSessionId in a ref for use in reconnect logic
  // (avoids stale closure issues when connect() is called during reconnect)
  const claudeSessionIdRef = useRef<string | null>(claudeSessionId);

  // Keep claudeSessionIdRef in sync with state and clear queue on session change
  useEffect(() => {
    // Clear queue when session changes to prevent cross-session message leaks
    if (claudeSessionIdRef.current !== claudeSessionId) {
      messageQueueRef.current = [];
    }
    claudeSessionIdRef.current = claudeSessionId;
  }, [claudeSessionId]);

  // Reset local UI state when switching to a different database session.
  // Messages will be reloaded from the backend for the new session.
  // This effect intentionally resets multiple state variables to ensure
  // clean separation between sessions.
  useEffect(() => {
    const prevDbSessionId = prevDbSessionIdRef.current;
    const newDbSessionId = dbSessionId ?? null;

    // Update refs
    dbSessionIdRef.current = newDbSessionId;
    prevDbSessionIdRef.current = newDbSessionId;

    // If switching to a different session, reset local state
    if (prevDbSessionId !== null && prevDbSessionId !== newDbSessionId) {
      debug.log('🔄 Session switch detected, resetting state', {
        from: prevDbSessionId,
        to: newDbSessionId,
      });

      // Clear messages - will be reloaded from backend
      setMessages([]);
      setClaudeSessionId(null);
      setGitBranch(null);
      setPendingPermission(null);
      setPendingQuestion(null);
      setStartingSession(false);
      setLoadingSession(false);
      setChatSettings(DEFAULT_CHAT_SETTINGS);
      setRunning(false);

      // Clear refs
      toolInputAccumulatorRef.current.clear();
      messageQueueRef.current = [];
      hasLoadedInitialSessionRef.current = false;
      loadedClaudeSessionIdRef.current = null;
    }
  }, [dbSessionId]);

  // Auto-scroll to bottom when messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: we want to trigger scroll on messages array change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  // Sync initial Claude session ref with prop and reset load flag when navigating to a different session
  // This handles: page refresh, direct URL navigation, and browser back/forward
  useEffect(() => {
    const claudeSessionId = initialClaudeSessionId ?? null;
    if (claudeSessionId !== initialClaudeSessionIdRef.current) {
      initialClaudeSessionIdRef.current = claudeSessionId;
      // Only reset the load flag if we haven't already loaded this session
      // This prevents duplicate loads when URL updates after loading via picker
      if (claudeSessionId !== loadedClaudeSessionIdRef.current) {
        hasLoadedInitialSessionRef.current = false;
      }
    }
  }, [initialClaudeSessionId]);

  // Flush queued messages when connection is open
  const flushMessageQueue = useCallback(() => {
    // Filter out stale time-sensitive messages that don't make sense after reconnect
    const originalLength = messageQueueRef.current.length;
    messageQueueRef.current = messageQueueRef.current.filter((msg) => {
      if (STALE_MESSAGE_TYPES.has(msg.type)) {
        debug.log('🗑️ Dropping stale queued message:', msg.type);
        return false;
      }
      return true;
    });
    if (originalLength !== messageQueueRef.current.length) {
      debug.log(
        `📤 Filtered ${originalLength - messageQueueRef.current.length} stale messages from queue`
      );
    }

    // Send queued messages in batches to avoid overwhelming the server
    let sentCount = 0;
    while (
      messageQueueRef.current.length > 0 &&
      wsRef.current?.readyState === WebSocket.OPEN &&
      sentCount < MAX_FLUSH_BATCH_SIZE
    ) {
      const msg = messageQueueRef.current.shift();
      if (msg) {
        messageCounterRef.current += 1;
        logWsMessage('OUT (queued)', msg, messageCounterRef.current);
        wsRef.current.send(JSON.stringify(msg));
        sentCount++;
      }
    }
    if (messageQueueRef.current.length > 0) {
      debug.log(
        `📤 ${messageQueueRef.current.length} messages remaining in queue after batch flush`
      );
    }
  }, []);

  // Send message to WebSocket (or queue if disconnected)
  const sendWsMessage = useCallback(
    (message: OutgoingMessage) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Flush any queued messages first
        flushMessageQueue();
        // Debug logging for outgoing messages
        messageCounterRef.current += 1;
        logWsMessage('OUT', message, messageCounterRef.current);
        wsRef.current.send(JSON.stringify(message));
      } else if (messageQueueRef.current.length < MAX_QUEUE_SIZE) {
        // Queue message for later delivery
        debug.log('📥 Queuing message for later delivery:', message.type);
        messageQueueRef.current.push(message);
      } else {
        debug.log('⚠️ Message queue full, dropping message:', message.type);
      }
    },
    [flushMessageQueue]
  );

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
      setGitBranch,
      setMessages,
      setAvailableSessions,
      setPendingPermission,
      setPendingQuestion,
      setLoadingSession,
      setStartingSession,
      setChatSettings,
      toolInputAccumulatorRef,
      updateToolInput,
      loadedClaudeSessionIdRef,
    }),
    [updateToolInput]
  );

  // Handle incoming WebSocket messages
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;

        // Debug logging for incoming messages
        messageCounterRef.current += 1;
        logWsMessage('IN', data, messageCounterRef.current);

        const handlers: Record<
          string,
          (data: WebSocketMessage, ctx: MessageHandlerContext) => void
        > = {
          status: handleStatusMessage,
          starting: handleStartingMessage,
          started: handleStartedMessage,
          stopped: (_, ctx) => {
            ctx.setRunning(false);
            ctx.setStartingSession(false);
          },
          process_exit: (_, ctx) => {
            ctx.setRunning(false);
            ctx.setStartingSession(false);
          },
          claude_message: handleClaudeMessage,
          error: handleErrorMessage,
          sessions: handleSessionsMessage,
          session_loaded: handleSessionLoadedMessage,
          permission_request: handlePermissionRequestMessage,
          user_question: handleUserQuestionMessage,
          message_queued: handleMessageQueuedMessage,
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
    // Don't connect without a valid dbSessionId
    if (!dbSessionIdRef.current) {
      debug.log('⏳ Waiting for dbSessionId before connecting');
      return;
    }

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

    // sessionId = dbSessionId (required, no temp IDs)
    // connectionId = unique per browser window for routing messages
    const wsParams: Record<string, string> = {
      sessionId: dbSessionIdRef.current,
      connectionId: connectionIdRef.current,
    };
    if (workingDir) {
      wsParams.workingDir = workingDir;
    }
    const wsUrl = buildWebSocketUrl('/chat', wsParams);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      const wasReconnect = reconnectAttemptsRef.current > 0;
      setConnected(true);
      reconnectAttemptsRef.current = 0;

      debug.log('🔌 WebSocket connected to:', wsUrl);
      debug.log('📊 Debug logging is ENABLED. Watch for ⬇️ IN and ⬆️ OUT messages.');
      if (wasReconnect) {
        debug.log('🔄 Reconnected successfully');
      }

      // Flush any queued messages from while we were disconnected
      flushMessageQueue();

      // Request list of available sessions
      sendWsMessage({ type: 'list_sessions' });

      // Load initial session on first connect, or reload on reconnect if we had a session
      if (initialClaudeSessionIdRef.current && !hasLoadedInitialSessionRef.current) {
        hasLoadedInitialSessionRef.current = true;
        setLoadingSession(true);
        sendWsMessage({ type: 'load_session', claudeSessionId: initialClaudeSessionIdRef.current });
      } else if (wasReconnect && claudeSessionIdRef.current) {
        // On reconnect, reload the current session to restore state
        // Use ref to get the current value, not stale closure value
        debug.log('🔄 Reloading session after reconnect:', claudeSessionIdRef.current);
        setLoadingSession(true);
        sendWsMessage({ type: 'load_session', claudeSessionId: claudeSessionIdRef.current });
      }
    };

    ws.onclose = () => {
      // Only handle this close event if this WebSocket is still the current one.
      // If wsRef.current is different or null, we've already moved on to a new connection
      // and should not reconnect from this stale close event.
      if (wsRef.current !== ws) {
        debug.log('🚫 Ignoring close event from replaced WebSocket');
        return;
      }

      setConnected(false);
      wsRef.current = null;

      // Attempt reconnect with exponential backoff
      if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        const delay = getReconnectDelay(reconnectAttemptsRef.current);
        debug.log(
          `🔄 Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttemptsRef.current + 1}/${MAX_RECONNECT_ATTEMPTS})`
        );
        reconnectAttemptsRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      } else {
        debug.log('❌ Max reconnection attempts reached');
      }
    };

    ws.onerror = () => {
      // WebSocket errors are handled by onclose
    };

    ws.onmessage = handleMessage;
  }, [flushMessageQueue, handleMessage, sendWsMessage, workingDir]);

  // Initialize WebSocket connection only when both workingDir AND dbSessionId are available
  // This prevents failed connections during initial render when workspace data hasn't loaded yet
  useEffect(() => {
    if (!(workingDir && dbSessionId)) {
      // Don't connect until we have both valid workingDir and dbSessionId
      return;
    }

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
  }, [connect, workingDir, dbSessionId]);

  // Actions
  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim()) {
        return;
      }

      // Add user message to local state immediately (optimistic UI)
      setMessages((prev) => [...prev, createUserMessage(text)]);

      // If Claude is not running, start it first
      if (!running) {
        // Show starting indicator immediately for user feedback
        setStartingSession(true);

        const startMsg: StartMessage = {
          type: 'start',
          // Include current settings when starting
          selectedModel: chatSettings.selectedModel,
          thinkingEnabled: chatSettings.thinkingEnabled,
          planModeEnabled: chatSettings.planModeEnabled,
        };
        // If we have a Claude CLI session, resume it
        if (claudeSessionId) {
          startMsg.resumeSessionId = claudeSessionId;
        }
        // Note: dbSessionId is now part of the WebSocket URL, not sent in messages
        sendWsMessage(startMsg);
      }

      // Send the user input
      // The backend will queue this if Claude process isn't ready yet
      // Append thinking suffix to enable extended thinking when thinking mode is enabled
      const messageToSend = chatSettings.thinkingEnabled ? `${text}${THINKING_SUFFIX}` : text;
      sendWsMessage({ type: 'user_input', text: messageToSend });
    },
    [running, claudeSessionId, chatSettings, sendWsMessage]
  );

  const stopChat = useCallback(() => {
    if (running) {
      sendWsMessage({ type: 'stop' });
    }
  }, [running, sendWsMessage]);

  const clearChat = useCallback(() => {
    // Stop any running Claude process
    if (running) {
      sendWsMessage({ type: 'stop' });
    }

    // Clear local state
    setMessages([]);
    setClaudeSessionId(null);
    setGitBranch(null);
    setPendingPermission(null);
    setPendingQuestion(null);
    setStartingSession(false);
    setChatSettings(DEFAULT_CHAT_SETTINGS);
    toolInputAccumulatorRef.current.clear();

    // Reset session tracking refs for fresh start
    loadedClaudeSessionIdRef.current = null;
    hasLoadedInitialSessionRef.current = false;
    initialClaudeSessionIdRef.current = null;

    // Reconnect with new dbSessionId (will be picked up from dbSessionIdRef)
    connect();
  }, [running, sendWsMessage, connect]);

  const loadSession = useCallback(
    (claudeSessionId: string) => {
      setLoadingSession(true);
      sendWsMessage({ type: 'load_session', claudeSessionId });
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

  const updateSettings = useCallback((settings: Partial<ChatSettings>) => {
    // Update local state - settings are inferred from session file on load,
    // not persisted to database
    setChatSettings((prev) => ({ ...prev, ...settings }));
  }, []);

  return {
    // State
    messages,
    connected,
    running,
    claudeSessionId,
    gitBranch,
    availableSessions,
    pendingPermission,
    pendingQuestion,
    loadingSession,
    startingSession,
    chatSettings,
    // Actions
    sendMessage,
    stopChat,
    clearChat,
    loadSession,
    approvePermission,
    answerQuestion,
    updateSettings,
    // Refs
    inputRef,
    messagesEndRef,
  };
}
