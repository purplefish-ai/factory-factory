import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import {
  CONNECT_TIMEOUT_MS,
  getReconnectDelay,
  STABLE_CONNECTION_MS,
} from '@/lib/websocket-config';
import {
  createTransportPing,
  isTransportFrame,
  TransportServerFrameSchema,
  withTransportOptIn,
} from '@/shared/websocket-transport';
import {
  type ChannelConnectionState,
  ConnectionHealthContext,
  type ConnectionHealthStore,
} from './websocket-connection-health';
import { ConnectionLiveness, setTrustedTimeout } from './websocket-liveness';

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
const STALE_MESSAGE_TYPES = new Set(['stop', 'interrupt', 'soft_stop']);

export type WebSocketQueuePolicy = 'replay' | 'drop';

export interface WebSocketSendOptions {
  /**
   * Drops this message instead of queuing it for replay when it cannot be sent now. Use it
   * when the caller treats a `false` return as "never sent" (for example to roll back
   * optimistic state). A drop transport never replays, so there is no 'replay' override.
   */
  queuePolicy?: 'drop';
}

export type WebSocketSend = (message: unknown, options?: WebSocketSendOptions) => boolean;

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

function parseFrame(data: unknown): { parsed: true; value: unknown } | { parsed: false } {
  if (typeof data !== 'string') {
    return { parsed: false };
  }
  try {
    const value: unknown = JSON.parse(data);
    return { parsed: true, value };
  } catch {
    return { parsed: false };
  }
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
  /** Called when connection is lost, including each failed reconnect attempt. */
  onDisconnected?: () => void;
  /**
   * How to handle outbound messages while disconnected.
   * - replay: queue and replay on reconnect
   * - drop: drop immediately and return false from send
   *
   * @default 'replay'
   */
  queuePolicy?: WebSocketQueuePolicy;
  /**
   * Shows this channel's lost connection in the app-wide connection banner
   * (`ConnectionHealthContext`). Set it for the channels every page depends
   * on; channels with their own disconnect UI, such as the terminals, leave
   * it unset.
   */
  announceConnectionLoss?: boolean;
}

export interface UseWebSocketTransportReturn {
  /** Whether the WebSocket is currently connected. */
  connected: boolean;
  /**
   * Send a message (will be JSON stringified).
   * If disconnected, message is queued for delivery on reconnect unless the effective
   * queue policy is 'drop'. Returns true if sent immediately, false if queued or dropped.
   */
  send: WebSocketSend;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Low-level WebSocket transport hook with automatic reconnection.
 *
 * Handles:
 * - Connection lifecycle management
 * - Reconnection that never gives up, with exponential backoff, jitter and a
 *   capped delay (`getReconnectDelay`), and a timeout for an attempt that
 *   never opens
 * - Transport frames below the channel (`@/shared/websocket-transport`): the
 *   server's version hello, reported to `ConnectionHealthContext`, and an
 *   application-level ping that drops a connection which stopped answering
 *   (`ConnectionLiveness`)
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
  const {
    url,
    onMessage,
    onConnected,
    onDisconnected,
    queuePolicy = 'replay',
    announceConnectionLoss = false,
  } = options;

  const health = useContext(ConnectionHealthContext);
  const channelId = useId();
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track intentional closes to prevent reconnection during React Strict Mode unmount
  const intentionalCloseRef = useRef(false);
  // Message queue for messages sent while disconnected
  const messageQueueRef = useRef<unknown[]>([]);
  const previousUrlRef = useRef<string | null>(null);
  // Per-socket timers: the open timeout while connecting, then the stability
  // timer that resets the backoff; the liveness pings once the server says hello.
  const cancelSocketTimerRef = useRef<(() => void) | null>(null);
  const livenessRef = useRef<ConnectionLiveness | null>(null);
  // The state last reported to the health store; null while no connection is wanted.
  const connectionStateRef = useRef<ChannelConnectionState | null>(null);
  const connectRef = useRef<() => void>(() => undefined);

  // Store callbacks in refs to avoid reconnection on callback changes
  const onMessageRef = useRef(onMessage);
  const onConnectedRef = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);
  const healthRef = useRef<ConnectionHealthStore | null>(health);
  const announceRef = useRef(announceConnectionLoss);

  // Update callback refs when callbacks change
  useEffect(() => {
    onMessageRef.current = onMessage;
    onConnectedRef.current = onConnected;
    onDisconnectedRef.current = onDisconnected;
  }, [onMessage, onConnected, onDisconnected]);

  // Joining or leaving the banner mid-connection publishes or withdraws the
  // current state, so the banner never keeps a state the channel moved past.
  useEffect(() => {
    healthRef.current = health;
    announceRef.current = announceConnectionLoss;
    const state = connectionStateRef.current;
    if (announceConnectionLoss && state !== null) {
      health?.setChannelState(channelId, state);
    }
    return () => health?.removeChannel(channelId);
  }, [health, announceConnectionLoss, channelId]);

  const reportState = useCallback(
    (state: ChannelConnectionState) => {
      if (connectionStateRef.current === state) {
        return;
      }
      connectionStateRef.current = state;
      if (announceRef.current) {
        healthRef.current?.setChannelState(channelId, state);
      }
    },
    [channelId]
  );

  const stopSocketTimers = useCallback(() => {
    cancelSocketTimerRef.current?.();
    cancelSocketTimerRef.current = null;
    livenessRef.current?.stop();
    livenessRef.current = null;
  }, []);

  // The current socket is gone (closed, timed out or abandoned as dead): fence it
  // off, report the loss and, unless the close was ours, retry. Retries never
  // stop; the backoff delay is capped.
  const loseSocket = useCallback(
    (ws: WebSocket): boolean => {
      if (wsRef.current !== ws) {
        return false;
      }
      stopSocketTimers();
      wsRef.current = null;
      setConnected(false);
      onDisconnectedRef.current?.();

      if (!intentionalCloseRef.current) {
        reportState('reconnecting');
        const delay = getReconnectDelay(reconnectAttemptsRef.current);
        reconnectAttemptsRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          connectRef.current();
        }, delay);
      }
      return true;
    },
    [reportState, stopSocketTimers]
  );

  // Drops a socket that is still open or connecting but no longer trusted.
  const abandonSocket = useCallback(
    (ws: WebSocket) => {
      if (loseSocket(ws)) {
        ws.close();
      }
    },
    [loseSocket]
  );

  const handleTransportFrame = useCallback((frame: unknown) => {
    const parsed = TransportServerFrameSchema.safeParse(frame);
    if (parsed.success && parsed.data.ffTransport === 'hello') {
      healthRef.current?.reportServerVersion(parsed.data.version);
      // The server answers pings, so liveness can start.
      livenessRef.current?.start();
    }
  }, []);

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

  const handleOpen = useCallback(
    (ws: WebSocket) => {
      cancelSocketTimerRef.current?.();
      setConnected(true);
      reportState('connected');
      const liveness = new ConnectionLiveness({
        sendPing: (id) =>
          ws.readyState === WebSocket.OPEN && trySendMessage(ws, createTransportPing(id)),
        onUnresponsive: () => reportState('unresponsive'),
        onResponsive: () => reportState('connected'),
        onDead: () => abandonSocket(ws),
      });
      livenessRef.current = liveness;
      // An open alone proves little: a server can accept the upgrade and then
      // stall. The backoff resets only once the connection has stayed open
      // and answering, so a server that keeps doing that is not retried at
      // the shortest delay every time.
      const awaitStability = () => {
        const handle = setTimeout(() => {
          if (liveness.isUnresponsive()) {
            awaitStability();
            return;
          }
          reconnectAttemptsRef.current = 0;
          cancelSocketTimerRef.current = null;
        }, STABLE_CONNECTION_MS);
        cancelSocketTimerRef.current = () => clearTimeout(handle);
      };
      awaitStability();

      if (queuePolicy !== 'replay') {
        messageQueueRef.current = [];
        onConnectedRef.current?.();
        return;
      }

      flushQueuedMessages(ws, true);

      onConnectedRef.current?.();
    },
    [abandonSocket, flushQueuedMessages, queuePolicy, reportState]
  );

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
      const previous = wsRef.current;
      stopSocketTimers();
      wsRef.current = null;
      setConnected(false);
      onDisconnectedRef.current?.();
      previous.close();
    }

    // Clear any pending reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Reset intentional close flag when establishing a new connection
    intentionalCloseRef.current = false;

    const ws = new WebSocket(withTransportOptIn(url));
    wsRef.current = ws;
    // An attempt can hang while opening, for example when a stopped server's
    // kernel still accepts the connection; give up on it and try again.
    cancelSocketTimerRef.current = setTrustedTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        abandonSocket(ws);
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (wsRef.current === ws) {
        handleOpen(ws);
      }
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) {
        return;
      }
      livenessRef.current?.frameReceived();
      const frame = parseFrame(event.data);
      if (!frame.parsed) {
        // Silently ignore binary frames and parse errors
        return;
      }
      if (isTransportFrame(frame.value)) {
        handleTransportFrame(frame.value);
        return;
      }
      onMessageRef.current?.(frame.value);
    };

    // A close event from a socket that is no longer current is ignored: the
    // transport has already moved on to a new connection.
    ws.onclose = () => {
      loseSocket(ws);
    };

    ws.onerror = () => {
      // WebSocket errors are handled by onclose
    };
  }, [abandonSocket, handleOpen, handleTransportFrame, loseSocket, stopSocketTimers, url]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

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
    const previousUrl = previousUrlRef.current;
    previousUrlRef.current = url;

    if (previousUrl !== null && url !== null && previousUrl !== url) {
      messageQueueRef.current = [];
      reconnectAttemptsRef.current = 0;
    }

    if (url) {
      reportState('connecting');
      connect();
    } else {
      // URL became null - disconnect and clear queue. With no connection
      // desired, a consumer that restores the URL starts a fresh backoff.
      intentionalCloseRef.current = true;
      messageQueueRef.current = [];
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
      reconnectAttemptsRef.current = 0;
    }

    return () => {
      // Mark as intentional close to prevent reconnection in onclose handler
      intentionalCloseRef.current = true;
      stopSocketTimers();
      connectionStateRef.current = null;
      healthRef.current?.removeChannel(channelId);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
        // The closing socket's onclose is ignored once wsRef is cleared, so
        // reflect the closed state here. Otherwise a URL change leaves
        // consumers reading connected=true while the replacement socket is
        // still connecting.
        setConnected(false);
      }
    };
  }, [url, connect, channelId, reportState, stopSocketTimers]);

  // Mobile browsers often suspend tabs and delay close events while backgrounded.
  // Recover immediately when the tab is foregrounded or network comes back, and
  // check an open connection at once: it may have died while the tab was away.
  // Liveness pauses while the tab is hidden, where throttled timers would
  // report a healthy connection as lost.
  useEffect(() => {
    if (!url || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const handleVisibilityChange = () => {
      livenessRef.current?.visibilityChanged();
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
      livenessRef.current?.checkNow();
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
    (message: unknown, sendOptions?: WebSocketSendOptions): boolean => {
      const ws = wsRef.current;
      const socketIsOpen = ws?.readyState === WebSocket.OPEN;
      const hasBacklog = messageQueueRef.current.length > 0;

      if (socketIsOpen && !hasBacklog && ws && trySendMessage(ws, message)) {
        return true;
      }

      if (queuePolicy !== 'replay' || sendOptions?.queuePolicy === 'drop') {
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

  return {
    connected,
    send,
  };
}
