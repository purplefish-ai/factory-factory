'use client';

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
  const { url, onMessage, onConnected, onDisconnected } = options;

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

      // Flush queued messages, filtering out stale time-sensitive ones
      const queue = messageQueueRef.current;
      messageQueueRef.current = [];

      // Filter out stale messages
      const validMessages = queue.filter((msg) => {
        const msgType = (msg as { type?: string }).type;
        if (msgType && STALE_MESSAGE_TYPES.has(msgType)) {
          return false;
        }
        return true;
      });

      // Send queued messages in batches
      const toSend = validMessages.slice(0, MAX_FLUSH_BATCH_SIZE);
      const remaining = validMessages.slice(MAX_FLUSH_BATCH_SIZE);

      for (const msg of toSend) {
        ws.send(JSON.stringify(msg));
      }

      // Re-queue any remaining messages
      if (remaining.length > 0) {
        messageQueueRef.current = remaining;
      }

      onConnectedRef.current?.();
    };

    ws.onmessage = (event) => {
      try {
        const data: unknown = JSON.parse(event.data as string);
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
  }, [url]);

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

  // Send a message (JSON stringified), queuing if disconnected
  const send = useCallback((message: unknown): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
      return true;
    }

    // Queue message for later delivery when reconnected
    if (messageQueueRef.current.length < MAX_QUEUE_SIZE) {
      messageQueueRef.current.push(message);
    }
    // Returns false to indicate message was queued, not sent immediately
    return false;
  }, []);

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
