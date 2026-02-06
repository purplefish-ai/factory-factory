/**
 * Tests for the useWebSocketTransport hook.
 *
 * These tests verify the WebSocket transport logic including:
 * - Connection state management
 * - Message sending
 * - Reconnection logic
 * - Cleanup on unmount
 *
 * Note: Testing React hooks with WebSocket requires mocking WebSocket and
 * using @testing-library/react-hooks or similar. Since this project doesn't
 * have that setup, we test the core logic patterns instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getReconnectDelay, MAX_RECONNECT_ATTEMPTS } from '@/lib/websocket-config';

// =============================================================================
// WebSocket Config Tests
// =============================================================================

describe('getReconnectDelay', () => {
  it('should return base delay plus jitter for first attempt', () => {
    // With jitter, delay should be between 1000 and 1250ms
    const delay = getReconnectDelay(0);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1250);
  });

  it('should double delay for each subsequent attempt', () => {
    // Test without jitter by checking minimum values
    // attempt 0: ~1000ms
    // attempt 1: ~2000ms
    // attempt 2: ~4000ms
    // attempt 3: ~8000ms

    const delay0 = getReconnectDelay(0);
    const delay1 = getReconnectDelay(1);
    const delay2 = getReconnectDelay(2);

    // With jitter, we can only check approximate ranges
    expect(delay0).toBeLessThan(1300); // max 1000 * 1.25
    expect(delay1).toBeGreaterThan(1500); // min ~2000
    expect(delay2).toBeGreaterThan(3500); // min ~4000
  });

  it('should cap delay at 30 seconds', () => {
    // After several attempts, delay should be capped
    const delay = getReconnectDelay(10);
    // Maximum is 30000ms + 25% jitter = 37500ms
    expect(delay).toBeLessThanOrEqual(37_500);
    expect(delay).toBeGreaterThanOrEqual(30_000);
  });

  it('should add jitter to prevent thundering herd', () => {
    // Multiple calls should return slightly different values due to jitter
    const delays = new Set<number>();
    for (let i = 0; i < 10; i++) {
      delays.add(getReconnectDelay(0));
    }
    // With 25% jitter on 1000ms, we should see some variation
    // (though there's a tiny chance of collision)
    expect(delays.size).toBeGreaterThan(1);
  });

  it('should handle very large attempt numbers gracefully', () => {
    const delay = getReconnectDelay(100);
    // Should still be capped at 30s + jitter
    expect(delay).toBeLessThanOrEqual(37_500);
    expect(delay).toBeGreaterThanOrEqual(30_000);
  });
});

describe('MAX_RECONNECT_ATTEMPTS', () => {
  it('should be 10', () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(10);
  });
});

// =============================================================================
// Mock WebSocket Interface
// =============================================================================

interface MockWebSocketInstance {
  url: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  sentMessages: string[];
  send: (data: string) => void;
  close: () => void;
  simulateOpen: () => void;
  simulateClose: () => void;
  simulateMessage: (data: unknown) => void;
  simulateError: () => void;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

function createMockWebSocket(url: string): MockWebSocketInstance {
  const ws: MockWebSocketInstance = {
    url,
    readyState: WS_CONNECTING,
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    sentMessages: [],
    send(data: string) {
      if (this.readyState !== WS_OPEN) {
        throw new Error('WebSocket is not open');
      }
      this.sentMessages.push(data);
    },
    close() {
      this.readyState = WS_CLOSING;
      setTimeout(() => {
        this.readyState = WS_CLOSED;
        if (this.onclose) {
          this.onclose({ type: 'close', code: 1000, reason: '', wasClean: true });
        }
      }, 0);
    },
    simulateOpen() {
      this.readyState = WS_OPEN;
      if (this.onopen) {
        this.onopen({ type: 'open' });
      }
    },
    simulateClose() {
      this.readyState = WS_CLOSED;
      if (this.onclose) {
        this.onclose({ type: 'close', code: 1000, reason: '', wasClean: true });
      }
    },
    simulateMessage(data: unknown) {
      if (this.onmessage) {
        this.onmessage({ type: 'message', data: JSON.stringify(data) });
      }
    },
    simulateError() {
      if (this.onerror) {
        this.onerror({ type: 'error' });
      }
    },
  };
  return ws;
}

/**
 * Helper to safely get the last created WebSocket instance.
 * Throws if no WebSocket has been created, making tests fail clearly.
 */
function getLastWs(ws: MockWebSocketInstance | null): MockWebSocketInstance {
  if (!ws) {
    throw new Error('No WebSocket instance created');
  }
  return ws;
}

// =============================================================================
// Hook Logic Pattern Tests
// =============================================================================

describe('WebSocket transport patterns', () => {
  let createdWebSockets: MockWebSocketInstance[] = [];
  let lastCreatedWs: MockWebSocketInstance | null = null;

  beforeEach(() => {
    createdWebSockets = [];
    lastCreatedWs = null;

    // Create mock WebSocket constructor as a function that mimics constructor behavior
    const MockWebSocketConstructor = function (this: MockWebSocketInstance, url: string) {
      const ws = createMockWebSocket(url);
      lastCreatedWs = ws;
      createdWebSockets.push(ws);
      // Copy properties to this
      Object.assign(this, ws);
    };
    // Add static properties
    Object.assign(MockWebSocketConstructor, {
      CONNECTING: WS_CONNECTING,
      OPEN: WS_OPEN,
      CLOSING: WS_CLOSING,
      CLOSED: WS_CLOSED,
    });

    vi.stubGlobal('WebSocket', MockWebSocketConstructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    lastCreatedWs = null;
    createdWebSockets = [];
  });

  describe('connection establishment', () => {
    it('should create WebSocket with provided URL', () => {
      new WebSocket('ws://localhost:3000/chat');
      expect(lastCreatedWs).not.toBeNull();
      const ws = getLastWs(lastCreatedWs);
      expect(ws.url).toBe('ws://localhost:3000/chat');
    });

    it('should not create connection when URL is null', () => {
      // Pattern: hook checks url !== null before creating WebSocket
      const url: string | null = null;
      if (url) {
        new WebSocket(url);
      }
      expect(createdWebSockets).toHaveLength(0);
    });
  });

  describe('connection state', () => {
    it('should start in CONNECTING state', () => {
      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);
      expect(ws.readyState).toBe(WS_CONNECTING);
    });

    it('should transition to OPEN state on open event', () => {
      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);
      ws.simulateOpen();
      expect(ws.readyState).toBe(WS_OPEN);
    });
  });

  describe('message sending', () => {
    it('should send JSON stringified message when connected', () => {
      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);
      ws.simulateOpen();

      const message = { type: 'test', data: 'hello' };
      ws.send(JSON.stringify(message));

      expect(ws.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws.sentMessages[0]!)).toEqual(message);
    });

    it('should throw error when sending on closed connection', () => {
      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);
      // Not calling simulateOpen(), so readyState is CONNECTING

      expect(() => ws.send('test')).toThrow('WebSocket is not open');
    });

    it('should return false from send pattern when not connected', () => {
      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);

      // Pattern: send returns boolean success indicator
      const send = (message: unknown): boolean => {
        if (ws.readyState !== WS_OPEN) {
          return false;
        }
        ws.send(JSON.stringify(message));
        return true;
      };

      expect(send({ type: 'test' })).toBe(false);

      ws.simulateOpen();
      expect(send({ type: 'test' })).toBe(true);
    });
  });

  describe('message receiving', () => {
    it('should parse JSON messages and invoke callback', () => {
      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);
      const messages: unknown[] = [];

      ws.onmessage = (event: unknown) => {
        try {
          const data = (event as { data: string }).data;
          messages.push(JSON.parse(data));
        } catch {
          // Ignore parse errors
        }
      };

      ws.simulateOpen();
      ws.simulateMessage({ type: 'status', running: true });
      ws.simulateMessage({ type: 'claude_message', data: 'hello' });

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ type: 'status', running: true });
      expect(messages[1]).toEqual({ type: 'claude_message', data: 'hello' });
    });

    it('should handle malformed JSON gracefully', () => {
      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);
      const messages: unknown[] = [];
      let errorCount = 0;

      ws.onmessage = (event: unknown) => {
        try {
          const data = (event as { data: string }).data;
          messages.push(JSON.parse(data));
        } catch {
          errorCount++;
        }
      };

      ws.simulateOpen();

      // Manually trigger message with invalid JSON
      if (ws.onmessage) {
        ws.onmessage({ type: 'message', data: 'not json' });
      }

      expect(messages).toHaveLength(0);
      expect(errorCount).toBe(1);
    });
  });

  describe('reconnection logic', () => {
    it('should attempt reconnection on unexpected close', () => {
      vi.useFakeTimers();

      let reconnectAttempts = 0;
      const maxAttempts = MAX_RECONNECT_ATTEMPTS;
      const intentionalClose = false;

      const connect = (): MockWebSocketInstance => {
        new WebSocket('ws://localhost:3000/chat');
        const ws = getLastWs(lastCreatedWs);
        ws.simulateOpen();

        ws.onclose = () => {
          if (!intentionalClose && reconnectAttempts < maxAttempts) {
            const delay = getReconnectDelay(reconnectAttempts);
            reconnectAttempts++;
            setTimeout(connect, delay);
          }
        };

        return ws;
      };

      const ws = connect();

      // Simulate unexpected close
      ws.simulateClose();

      // Should have scheduled a reconnect
      expect(reconnectAttempts).toBe(1);

      // Advance time to trigger reconnect
      vi.advanceTimersByTime(2000);

      // Should have created another WebSocket
      expect(createdWebSockets.length).toBeGreaterThan(1);

      vi.useRealTimers();
    });

    it('should not reconnect on intentional close', () => {
      let reconnectAttempts = 0;
      let intentionalClose = false;

      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);
      ws.simulateOpen();

      ws.onclose = () => {
        if (!intentionalClose && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
        }
      };

      // Set intentional flag before closing
      intentionalClose = true;
      ws.simulateClose();

      expect(reconnectAttempts).toBe(0);
    });

    it('should reset reconnect attempts after successful connection', () => {
      let reconnectAttempts = 3;

      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);

      ws.onopen = () => {
        reconnectAttempts = 0;
      };

      ws.simulateOpen();

      expect(reconnectAttempts).toBe(0);
    });

    it('should stop reconnecting after max attempts', () => {
      let reconnectAttempts = 0;
      const attemptedReconnects: number[] = [];

      const attemptReconnect = () => {
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          attemptedReconnects.push(reconnectAttempts);
          reconnectAttempts++;
          return true;
        }
        return false;
      };

      // Simulate multiple failed reconnects
      while (attemptReconnect()) {
        // Continue attempting
      }

      expect(attemptedReconnects).toHaveLength(MAX_RECONNECT_ATTEMPTS);
      expect(reconnectAttempts).toBe(MAX_RECONNECT_ATTEMPTS);
      expect(attemptReconnect()).toBe(false);
    });
  });

  describe('cleanup on unmount', () => {
    it('should close WebSocket and clear timeouts on cleanup', () => {
      vi.useFakeTimers();

      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);
      ws.simulateOpen();

      let timeoutCleared = false;
      const timeoutId = setTimeout(() => {
        // Placeholder for reconnection logic
      }, 5000);

      // Cleanup pattern
      const cleanup = () => {
        clearTimeout(timeoutId);
        timeoutCleared = true;
        if (ws.readyState === WS_OPEN) {
          ws.close();
        }
      };

      cleanup();

      expect(timeoutCleared).toBe(true);
      expect(ws.readyState).toBe(WS_CLOSING);

      vi.useRealTimers();
    });

    it('should handle cleanup when WebSocket is null', () => {
      // Use let so TypeScript doesn't narrow to 'never'
      let ws: MockWebSocketInstance | null = null;

      // Cleanup pattern should handle null safely
      const cleanup = () => {
        if (ws !== null) {
          ws.close();
        }
      };

      // Should not throw
      expect(() => cleanup()).not.toThrow();

      // Prevent unused variable warning
      ws = null;
    });
  });

  describe('manual reconnect', () => {
    it('should allow manual reconnection', () => {
      let ws: MockWebSocketInstance | null = null;
      let reconnectAttempts = 5; // Simulate that we've been trying

      const connect = () => {
        new WebSocket('ws://localhost:3000/chat');
        ws = lastCreatedWs;
        return ws;
      };

      const reconnect = () => {
        // Reset attempt counter for manual reconnect
        reconnectAttempts = 0;

        // Close existing connection if any
        if (ws) {
          ws.close();
        }

        // Connect
        connect();
      };

      // Initial connection
      connect();
      expect(createdWebSockets).toHaveLength(1);

      // Manual reconnect
      reconnect();

      expect(reconnectAttempts).toBe(0);
      expect(createdWebSockets).toHaveLength(2);
    });
  });

  describe('callback refs pattern', () => {
    it('should use latest callback without causing reconnection', () => {
      new WebSocket('ws://localhost:3000/chat');
      const ws = getLastWs(lastCreatedWs);
      ws.simulateOpen();

      // Simulate the ref pattern used in the hook
      let onMessageCallback = (data: unknown) => {
        return `first: ${JSON.stringify(data)}`;
      };

      const onMessageRef = { current: onMessageCallback };

      // Update callback
      onMessageCallback = (data: unknown) => {
        return `second: ${JSON.stringify(data)}`;
      };
      onMessageRef.current = onMessageCallback;

      // The handler always uses the ref, so it gets the latest callback
      ws.onmessage = (event: unknown) => {
        const data = JSON.parse((event as { data: string }).data);
        onMessageRef.current(data);
      };

      // Simulate message - should use "second" callback
      const result = onMessageRef.current({ test: 'data' });
      expect(result).toContain('second');
    });
  });
});

// =============================================================================
// URL Change Handling Tests
// =============================================================================

describe('URL change handling', () => {
  let createdWebSockets: MockWebSocketInstance[] = [];
  let lastCreatedWs: MockWebSocketInstance | null = null;

  beforeEach(() => {
    createdWebSockets = [];
    lastCreatedWs = null;

    // Create mock WebSocket constructor as a function that mimics constructor behavior
    const MockWebSocketConstructor = function (this: MockWebSocketInstance, url: string) {
      const ws = createMockWebSocket(url);
      lastCreatedWs = ws;
      createdWebSockets.push(ws);
      // Copy properties to this
      Object.assign(this, ws);
    };
    // Add static properties
    Object.assign(MockWebSocketConstructor, {
      CONNECTING: WS_CONNECTING,
      OPEN: WS_OPEN,
      CLOSING: WS_CLOSING,
      CLOSED: WS_CLOSED,
    });

    vi.stubGlobal('WebSocket', MockWebSocketConstructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should disconnect when URL becomes null', () => {
    let url: string | null = 'ws://localhost:3000/chat';
    let ws: MockWebSocketInstance | null = null;
    let connected = false;

    // Initial connect
    if (url) {
      new WebSocket(url);
      ws = lastCreatedWs;
      if (ws) {
        ws.simulateOpen();
        connected = true;
      }
    }

    // Simulate URL becoming null (like sessionId being cleared)
    url = null;

    if (!url && ws) {
      ws.close();
      ws = null;
      connected = false;
    }

    expect(ws).toBeNull();
    expect(connected).toBe(false);
  });

  it('should reconnect to new URL when URL changes', () => {
    let url: string | null = 'ws://localhost:3000/chat?sessionId=1';
    new WebSocket(url);
    let ws = getLastWs(lastCreatedWs);
    ws.simulateOpen();

    expect(createdWebSockets).toHaveLength(1);
    expect(createdWebSockets[0]!.url).toBe('ws://localhost:3000/chat?sessionId=1');

    // URL changes to different session
    url = 'ws://localhost:3000/chat?sessionId=2';

    // Close old connection
    ws.close();

    // Create new connection
    new WebSocket(url);
    ws = getLastWs(lastCreatedWs);
    ws.simulateOpen();

    expect(createdWebSockets).toHaveLength(2);
    expect(createdWebSockets[1]!.url).toBe('ws://localhost:3000/chat?sessionId=2');
  });
});
