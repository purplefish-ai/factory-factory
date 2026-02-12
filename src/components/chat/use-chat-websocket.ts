import { useCallback, useEffect, useRef } from 'react';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import type {
  ChatMessage,
  ChatSettings,
  CommandInfo,
  MessageAttachment,
  QueuedMessage,
  SessionInfo,
  TokenStats,
} from '@/lib/claude-types';
import { buildWebSocketUrl } from '@/lib/websocket-config';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type {
  PendingMessageContent,
  PendingRequest,
  RewindPreviewState,
  SessionStatus,
} from './reducer';
import { useChatState } from './use-chat-state';

const LOAD_SESSION_RETRY_TIMEOUT_MS = 10_000;

// =============================================================================
// Types
// =============================================================================

export interface UseChatWebSocketOptions {
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
  // Session lifecycle status (replaces running, stopping, loadingSession, startingSession)
  sessionStatus: SessionStatus;
  // Claude process status (alive vs stopped)
  processStatus: ReturnType<typeof useChatState>['processStatus'];
  gitBranch: string | null;
  availableSessions: SessionInfo[];
  // Pending interactive request (permission or user question)
  pendingRequest: PendingRequest;
  // Chat settings
  chatSettings: ChatSettings;
  chatCapabilities: ChatBarCapabilities;
  // Input draft (preserved across tab switches)
  inputDraft: string;
  // Input attachments (for recovery on rejection)
  inputAttachments: MessageAttachment[];
  // Message queue state
  queuedMessages: QueuedMessage[];
  // Latest thinking content from extended thinking mode
  latestThinking: string | null;
  // Pending messages awaiting backend confirmation (Map from ID to content for recovery)
  pendingMessages: Map<string, PendingMessageContent>;
  // Context compaction state
  isCompacting: boolean;
  // Task notifications from SDK
  taskNotifications: { id: string; message: string; timestamp: string }[];
  // Current permission mode from SDK status updates
  permissionMode: string | null;
  // Slash commands from CLI initialize response
  slashCommands: CommandInfo[];
  // Whether slash commands have finished loading for this session
  slashCommandsLoaded: boolean;
  // Accumulated token usage stats for the session
  tokenStats: TokenStats;
  // Rewind preview state (for confirmation dialog)
  rewindPreview: RewindPreviewState | null;
  // Actions
  sendMessage: (text: string) => void;
  stopChat: () => void;
  clearChat: () => void;
  approvePermission: (requestId: string, allow: boolean) => void;
  answerQuestion: (requestId: string, answers: Record<string, string | string[]>) => void;
  updateSettings: (settings: Partial<ChatSettings>) => void;
  setInputDraft: (draft: string) => void;
  setInputAttachments: (attachments: MessageAttachment[]) => void;
  removeQueuedMessage: (id: string) => void;
  resumeQueuedMessages: () => void;
  // Task notification actions
  dismissTaskNotification: (id: string) => void;
  clearTaskNotifications: () => void;
  // Rewind files actions
  startRewindPreview: (userMessageUuid: string) => void;
  confirmRewind: () => void;
  cancelRewind: () => void;
  /** Get the SDK-assigned UUID for a user message by its stable message ID */
  getUuidForMessageId: (messageId: string) => string | undefined;
  // Refs
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Chat WebSocket hook that composes transport and state management.
 *
 * This is a thin wrapper that:
 * 1. Uses useWebSocketTransport for connection management
 * 2. Uses useChatState for all chat state and actions
 * 3. Wires them together with the appropriate callbacks
 */
export function useChatWebSocket(options: UseChatWebSocketOptions): UseChatWebSocketReturn {
  const { dbSessionId } = options;

  // Unique connection ID for this browser window (stable across reconnects)
  const connectionIdRef = useRef<string>(
    `conn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  );

  // Build WebSocket URL - null if no dbSessionId (transport won't connect)
  const url = dbSessionId
    ? buildWebSocketUrl('/chat', {
        sessionId: dbSessionId,
        connectionId: connectionIdRef.current,
      })
    : null;

  // Ref-wiring pattern to break circular dependency:
  // - useChatState needs a `send` function to send WebSocket messages
  // - useWebSocketTransport provides `send`, but needs `handleMessage` from chat state
  // Solution: Create a ref that starts as a no-op, pass a callback that uses the ref
  // to useChatState, then wire up the ref to transport.send after transport is created.
  // This works because:
  // 1. sendRef.current is updated synchronously after useWebSocketTransport returns
  // 2. The callback wrapper ((msg) => sendRef.current(msg)) always uses the latest ref value
  const sendRef = useRef<(message: unknown) => boolean>(() => false);
  const currentLoadRequestIdRef = useRef<string | null>(null);
  const currentLoadGenerationRef = useRef(0);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLoadTimeout = useCallback(() => {
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  }, []);

  const scheduleLoadRetry = useCallback(
    (loadGeneration: number, loadRequestId: string) => {
      clearLoadTimeout();
      loadTimeoutRef.current = setTimeout(() => {
        if (
          currentLoadGenerationRef.current !== loadGeneration ||
          currentLoadRequestIdRef.current !== loadRequestId
        ) {
          loadTimeoutRef.current = null;
          return;
        }

        const nextLoadRequestId = `load-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        currentLoadRequestIdRef.current = nextLoadRequestId;
        sendRef.current({ type: 'load_session', loadRequestId: nextLoadRequestId });
        scheduleLoadRetry(loadGeneration, nextLoadRequestId);
      }, LOAD_SESSION_RETRY_TIMEOUT_MS);
    },
    [clearLoadTimeout]
  );

  const chat = useChatState({
    dbSessionId,
    send: useCallback((message: unknown) => sendRef.current(message), []),
    connected: false, // Will be overridden by transport.connected in return value
  });

  // Handle incoming messages - delegate to chat state
  const handleMessage = useCallback(
    (data: unknown) => {
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        ((data as { type?: string }).type === 'session_replay_batch' ||
          (data as { type?: string }).type === 'session_snapshot')
      ) {
        const batch = data as { loadRequestId?: string; type?: string };
        if (currentLoadRequestIdRef.current && batch.loadRequestId) {
          if (batch.loadRequestId !== currentLoadRequestIdRef.current) {
            return;
          }
          // Only clear when we have a matching ID
          currentLoadRequestIdRef.current = null;
          clearLoadTimeout();
        }
      }
      chat.handleMessage(data);
    },
    [chat.handleMessage, clearLoadTimeout]
  );

  // Handle connection established - request session data and available sessions
  const handleConnected = useCallback(() => {
    // Dispatch loading state to prevent flicker while replaying events
    chat.dispatch({ type: 'SESSION_LOADING_START' });
    const loadGeneration = currentLoadGenerationRef.current + 1;
    currentLoadGenerationRef.current = loadGeneration;
    const loadRequestId = `load-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    currentLoadRequestIdRef.current = loadRequestId;
    scheduleLoadRetry(loadGeneration, loadRequestId);
    sendRef.current({ type: 'list_sessions' });
    sendRef.current({ type: 'load_session', loadRequestId }); // Hydrates via snapshot or replay batch
  }, [chat.dispatch, scheduleLoadRetry]);

  // Handle disconnection - clear loading state to avoid stuck spinner
  const handleDisconnected = useCallback(() => {
    currentLoadRequestIdRef.current = null;
    currentLoadGenerationRef.current += 1;
    clearLoadTimeout();
    chat.dispatch({ type: 'SESSION_LOADING_END' });
  }, [chat.dispatch, clearLoadTimeout]);

  // Ensure pending load timers cannot fire after unmount.
  useEffect(() => {
    return () => {
      currentLoadRequestIdRef.current = null;
      currentLoadGenerationRef.current += 1;
      clearLoadTimeout();
    };
  }, [clearLoadTimeout]);

  // Set up transport with callbacks
  const transport = useWebSocketTransport({
    url,
    onMessage: handleMessage,
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
  });

  // Wire up the send function to the transport
  sendRef.current = transport.send;

  return {
    // State from chat
    messages: chat.messages,
    connected: transport.connected,
    sessionStatus: chat.sessionStatus,
    processStatus: chat.processStatus,
    gitBranch: chat.gitBranch,
    availableSessions: chat.availableSessions,
    pendingRequest: chat.pendingRequest,
    chatSettings: chat.chatSettings,
    chatCapabilities: chat.chatCapabilities,
    inputDraft: chat.inputDraft,
    inputAttachments: chat.inputAttachments,
    queuedMessages: chat.queuedMessages,
    latestThinking: chat.latestThinking,
    pendingMessages: chat.pendingMessages,
    isCompacting: chat.isCompacting,
    taskNotifications: chat.taskNotifications,
    permissionMode: chat.permissionMode,
    slashCommands: chat.slashCommands,
    slashCommandsLoaded: chat.slashCommandsLoaded,
    tokenStats: chat.tokenStats,
    rewindPreview: chat.rewindPreview,
    // Actions from chat
    sendMessage: chat.sendMessage,
    stopChat: chat.stopChat,
    clearChat: chat.clearChat,
    approvePermission: chat.approvePermission,
    answerQuestion: chat.answerQuestion,
    updateSettings: chat.updateSettings,
    setInputDraft: chat.setInputDraft,
    setInputAttachments: chat.setInputAttachments,
    removeQueuedMessage: chat.removeQueuedMessage,
    resumeQueuedMessages: chat.resumeQueuedMessages,
    dismissTaskNotification: chat.dismissTaskNotification,
    clearTaskNotifications: chat.clearTaskNotifications,
    // Rewind files actions
    startRewindPreview: chat.startRewindPreview,
    confirmRewind: chat.confirmRewind,
    cancelRewind: chat.cancelRewind,
    getUuidForMessageId: chat.getUuidForMessageId,
    // Refs from chat
    inputRef: chat.inputRef,
    messagesEndRef: chat.messagesEndRef,
  };
}
