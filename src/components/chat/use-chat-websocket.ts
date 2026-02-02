'use client';

import { useCallback, useRef } from 'react';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import type {
  ChatMessage,
  ChatSettings,
  MessageAttachment,
  QueuedMessage,
  SessionInfo,
} from '@/lib/claude-types';
import { buildWebSocketUrl } from '@/lib/websocket-config';
import type { PendingMessageContent, PendingRequest, SessionStatus } from './chat-reducer';
import { useChatState } from './use-chat-state';

// =============================================================================
// Types
// =============================================================================

export interface UseChatWebSocketOptions {
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
  // Session lifecycle status (replaces running, stopping, loadingSession, startingSession)
  sessionStatus: SessionStatus;
  gitBranch: string | null;
  availableSessions: SessionInfo[];
  // Pending interactive request (permission or user question)
  pendingRequest: PendingRequest;
  // Chat settings
  chatSettings: ChatSettings;
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
  // Task notification actions
  dismissTaskNotification: (id: string) => void;
  clearTaskNotifications: () => void;
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
  const { workingDir, dbSessionId } = options;

  // Unique connection ID for this browser window (stable across reconnects)
  const connectionIdRef = useRef<string>(
    `conn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  );

  // Build WebSocket URL - null if no dbSessionId (transport won't connect)
  const url =
    dbSessionId && workingDir
      ? buildWebSocketUrl('/chat', {
          sessionId: dbSessionId,
          connectionId: connectionIdRef.current,
          workingDir,
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

  const chat = useChatState({
    dbSessionId,
    send: useCallback((message: unknown) => sendRef.current(message), []),
    connected: false, // Will be overridden by transport.connected in return value
  });

  // Handle incoming messages - delegate to chat state
  const handleMessage = useCallback(
    (data: unknown) => {
      chat.handleMessage(data);
    },
    [chat.handleMessage]
  );

  // Handle connection established - request session data and available sessions
  const handleConnected = useCallback(() => {
    sendRef.current({ type: 'list_sessions' });
    sendRef.current({ type: 'load_session' }); // Loads history and sends messages_snapshot
  }, []);

  // Set up transport with callbacks
  const transport = useWebSocketTransport({
    url,
    onMessage: handleMessage,
    onConnected: handleConnected,
  });

  // Wire up the send function to the transport
  sendRef.current = transport.send;

  return {
    // State from chat
    messages: chat.messages,
    connected: transport.connected,
    sessionStatus: chat.sessionStatus,
    gitBranch: chat.gitBranch,
    availableSessions: chat.availableSessions,
    pendingRequest: chat.pendingRequest,
    chatSettings: chat.chatSettings,
    inputDraft: chat.inputDraft,
    inputAttachments: chat.inputAttachments,
    queuedMessages: chat.queuedMessages,
    latestThinking: chat.latestThinking,
    pendingMessages: chat.pendingMessages,
    isCompacting: chat.isCompacting,
    taskNotifications: chat.taskNotifications,
    permissionMode: chat.permissionMode,
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
    dismissTaskNotification: chat.dismissTaskNotification,
    clearTaskNotifications: chat.clearTaskNotifications,
    // Refs from chat
    inputRef: chat.inputRef,
    messagesEndRef: chat.messagesEndRef,
  };
}
