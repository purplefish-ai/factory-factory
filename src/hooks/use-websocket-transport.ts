import { useCallback, useEffect, useRef, useState } from 'react';
import { getReconnectDelay, MAX_RECONNECT_ATTEMPTS } from '@/lib/websocket-config';

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of messages to queue while disconnected. */
const MAX_QUEUE_SIZE = 100;

/** Maximum number of queued messages to send per flush to avoid overwhelming the server. */
const MAX_FLUSH_BATCH_SIZE = 10;

/**
 * Message types that are time-sensitive and should not be queued/replayed after reconnect.
 * These commands only make sense in the context of an active session at the time they were sent.
 */
const STALE_MESSAGE_TYPES = new Set(['stop', 'interrupt']);

export type WebSocketQueuePolicy = 'replay' | 'drop';

function isStaleReplayMessage(message: unknown): boolean {
  const messageType =
    typeof message === 'object' && message !== null && 'type' in message ? message.type : undefined;
  return typeof messageType === 'string' && STALE_MESSAGE_TYPES.has(messageType);
}

function serializeMessage(message: unknown): string | null {
  try {
    const serialized = JSON.stringify(message);
    return typeof serialized === 'string' ? serialized : null;
  } catch {
    return null;
  }
}

function trySendMessage(ws: WebSocket, message: unknown): boolean {
  const serialized = serializeMessage(message);
  if (serialized === null) {
    return false;
  }

  try {
    ws.send(serialized);
    return true;
  } catch {
    return false;
  }
}

function sendMessageBatch(
  ws: WebSocket,
  messages: unknown[],
  startIndex: number,
  endIndex: number
): number {
  let index = startIndex;
  for (; index < endIndex; index += 1) {
    const msg = messages[index];
    if (msg === undefined) {
      continue;
    }

    const serialized = serializeMessage(msg);
    if (serialized === null) {
      continue;
    }

    try {
      ws.send(serialized);
    } catch {
      return index;
    }
  }
  return index;
}

// =============================================================================
// Types
// =============================================================================

export interface UseWebSocketTransportOptions {
  /** WebSocket URL to connect to. Set to null to defer connection. */
  url: string | null;
  /** Called when a message is received (after JSON parsing). */
  onMessage?: (data: unknown) => void;
  /** Called when connection is established. */
  onConnected?: () => void;
  /** Called when connection is lost. */
  onDisconnected?: () => void;
  /**
   * How to handle outbound messages while disconnected.
   * - replay: queue and replay on reconnect
   * - drop: drop immediately and return false from send
   *
   * @default 'replay'
   */
  queuePolicy?: WebSocketQueuePolicy;
}

export interface UseWebSocketTransportReturn {
  /** Whether the WebSocket is currently connected. */
  connected: boolean;
  /**
   * Send a message (will be JSON stringified).
   * If disconnected, message is queued for delivery on reconnect.
   * Returns true if sent immediately, false if queued or dropped.
   */
  send: (message: unknown) => boolean;
  /** Manually trigger a reconnection attempt. */
  reconnect: () => void;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Low-level WebSocket transport hook with automatic reconnection.
 *
 * Handles:
 * - Connection lifecycle management
 * - Exponential backoff reconnection with jitter
 * - JSON serialization/deserialization
 * - Proper cleanup on unmount
 *
 * @example
 * ```ts
 * const { connected, send } = useWebSocketTransport({
 *   url: sessionId ? buildWebSocketUrl('/chat', { sessionId }) : null,
 *   onMessage: (data) => handleMessage(data as ChatMessage),
 *   onConnected: () => console.log('Connected'),
 * });
 * ```
 */
export function useWebSocketTransport(
  options: UseWebSocketTransportOptions
): UseWebSocketTransportReturn {
  const { url, onMessage, onConnected, onDisconnected, queuePolicy = 'replay' } = options;

  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track intentional closes to prevent reconnection during React Strict Mode unmount
  const intentionalCloseRef = useRef(false);
  // Message queue for messages sent while disconnected
  const messageQueueRef = useRef<unknown[]>([]);

  // Store callbacks in refs to avoid reconnection on callback changes
  const onMessageRef = useRef(onMessage);
  const onConnectedRef = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);

  // Update callback refs when callbacks change
  useEffect(() => {
    onMessageRef.current = onMessage;
    onConnectedRef.current = onConnected;
    onDisconnectedRef.current = onDisconnected;
  }, [onMessage, onConnected, onDisconnected]);

  // Drain replay queue in FIFO order, preserving unsent messages if send fails.
  const flushQueuedMessages = useCallback((ws: WebSocket, dropStaleMessages: boolean) => {
    const validMessages = dropStaleMessages
      ? messageQueueRef.current.filter((msg) => !isStaleReplayMessage(msg))
      : messageQueueRef.current;
    messageQueueRef.current = [];

    let index = 0;
    while (index < validMessages.length) {
      if (ws.readyState !== WebSocket.OPEN) {
        messageQueueRef.current = validMessages.slice(index);
        return;
      }

      const batchEnd = Math.min(index + MAX_FLUSH_BATCH_SIZE, validMessages.length);
      const nextIndex = sendMessageBatch(ws, validMessages, index, batchEnd);
      if (nextIndex < batchEnd) {
        messageQueueRef.current = validMessages.slice(nextIndex);
        return;
      }
      index = nextIndex;
    }
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    // Don't connect if no URL provided
    if (!url) {
      return;
    }

    // Don't create new connection if one is already open
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Close any existing WebSocket in a transitional state (CONNECTING, CLOSING)
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Clear any pending reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Reset intentional close flag when establishing a new connection
    intentionalCloseRef.current = false;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttemptsRef.current = 0;

      if (queuePolicy !== 'replay') {
        messageQueueRef.current = [];
        onConnectedRef.current?.();
        return;
      }

      flushQueuedMessages(ws, true);

      onConnectedRef.current?.();
    };

    ws.onmessage = (event) => {
      try {
        if (typeof event.data !== 'string') {
          return;
        }
        const data: unknown = JSON.parse(event.data);
        onMessageRef.current?.(data);
      } catch {
        // Silently ignore parse errors
      }
    };

    ws.onclose = () => {
      // Only handle this close event if this WebSocket is still the current one.
      // If wsRef.current is different or null, we've already moved on to a new connection
      // and should not reconnect from this stale close event.
      if (wsRef.current !== ws) {
        return;
      }

      setConnected(false);
      wsRef.current = null;
      onDisconnectedRef.current?.();

      // Only attempt to reconnect if this wasn't an intentional close
      if (!intentionalCloseRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        const delay = getReconnectDelay(reconnectAttemptsRef.current);
        reconnectAttemptsRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      }
    };

    ws.onerror = () => {
      // WebSocket errors are handled by onclose
    };
  }, [flushQueuedMessages, queuePolicy, url]);

  // Attempt immediate recovery when the app returns to the foreground or network.
  const recoverConnection = useCallback(() => {
    if (!url) {
      return;
    }

    // Avoid connection churn while offline.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return;
    }

    // If already connected or connecting, no recovery needed.
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    // Treat lifecycle recovery as a fresh retry window.
    reconnectAttemptsRef.current = 0;
    intentionalCloseRef.current = false;
    connect();
  }, [connect, url]);

  // Connect when URL becomes available, disconnect when it becomes null
  useEffect(() => {
    if (url) {
      connect();
    } else {
      // URL became null - disconnect and clear queue
      intentionalCloseRef.current = true;
      messageQueueRef.current = [];
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
    }

    return () => {
      // Mark as intentional close to prevent reconnection in onclose handler
      intentionalCloseRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [url, connect]);

  // Mobile browsers often suspend tabs and delay close events while backgrounded.
  // Recover immediately when the tab is foregrounded or network comes back.
  useEffect(() => {
    if (!url || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        recoverConnection();
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        recoverConnection();
      }
    };
    const handleOnline = () => {
      recoverConnection();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleOnline);
    };
  }, [url, recoverConnection]);

  // Send a message (JSON stringified), queuing if disconnected
  const send = useCallback(
    (message: unknown): boolean => {
      const ws = wsRef.current;
      const socketIsOpen = ws?.readyState === WebSocket.OPEN;
      const hasBacklog = messageQueueRef.current.length > 0;

      if (socketIsOpen && !hasBacklog && ws && trySendMessage(ws, message)) {
        return true;
      }

      if (queuePolicy !== 'replay') {
        return false;
      }

      // Queue message for later delivery when reconnected
      if (messageQueueRef.current.length < MAX_QUEUE_SIZE) {
        messageQueueRef.current.push(message);
      }

      if (socketIsOpen && ws) {
        flushQueuedMessages(ws, false);
      }

      // Returns false to indicate message was queued, not sent immediately
      return false;
    },
    [flushQueuedMessages, queuePolicy]
  );

  // Manual reconnect
  const reconnect = useCallback(() => {
    // Reset attempt counter for manual reconnect
    reconnectAttemptsRef.current = 0;
    intentionalCloseRef.current = false;

    // Clear message queue on manual reconnect to avoid stale messages
    messageQueueRef.current = [];

    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Connect
    connect();
  }, [connect]);

  return {
    connected,
    send,
    reconnect,
  };
}
