/**
 * Tests for ChatConnectionService
 *
 * Focuses on connection lifecycle and race condition scenarios.
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { WS_READY_STATE, type WsReadyState } from '@/backend/constants/websocket';
import { ChatConnectionService, type ConnectionInfo } from './chat-connection.service';

vi.mock('@/backend/domains/session/logging/session-file-logger.service', () => ({
  sessionFileLogger: {
    log: vi.fn(),
  },
}));

vi.mock('@/backend/services/config.service', () => ({
  configService: {
    getDebugConfig: () => ({ chatWebSocket: false }),
  },
}));

// Mock WebSocket implementation
class MockWebSocket extends EventEmitter {
  private _readyState: WsReadyState = WS_READY_STATE.OPEN;

  get readyState(): WsReadyState {
    return this._readyState;
  }

  setReadyState(state: WsReadyState): void {
    this._readyState = state;
  }

  send = vi.fn();
  close = vi.fn();
}

describe('ChatConnectionService', () => {
  let chatConnectionService: ChatConnectionService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a new instance to avoid test pollution
    chatConnectionService = new ChatConnectionService();
  });

  describe('connection registration', () => {
    it('should register a new connection', () => {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const connectionId = 'conn-123';
      const info: ConnectionInfo = {
        ws,
        dbSessionId: 'session-456',
        workingDir: '/test/dir',
      };

      chatConnectionService.register(connectionId, info);

      expect(chatConnectionService.has(connectionId)).toBe(true);
      expect(chatConnectionService.get(connectionId)).toBe(info);
    });

    it('should unregister a connection', () => {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const connectionId = 'conn-123';
      const info: ConnectionInfo = {
        ws,
        dbSessionId: 'session-456',
        workingDir: '/test/dir',
      };

      chatConnectionService.register(connectionId, info);
      chatConnectionService.unregister(connectionId);

      expect(chatConnectionService.has(connectionId)).toBe(false);
      expect(chatConnectionService.get(connectionId)).toBeUndefined();
    });
  });

  describe('reconnection race condition', () => {
    it('should replace old connection when same connectionId reconnects', () => {
      const oldWs = new MockWebSocket() as unknown as WebSocket;
      const newWs = new MockWebSocket() as unknown as WebSocket;
      const connectionId = 'conn-123';
      const dbSessionId = 'session-456';

      // Register first connection
      chatConnectionService.register(connectionId, {
        ws: oldWs,
        dbSessionId,
        workingDir: '/test/dir',
      });

      // Verify first connection is registered
      expect(chatConnectionService.get(connectionId)?.ws).toBe(oldWs);

      // Register new connection with same connectionId (simulating reconnect)
      chatConnectionService.register(connectionId, {
        ws: newWs,
        dbSessionId,
        workingDir: '/test/dir',
      });

      // Verify new connection replaced old one
      expect(chatConnectionService.get(connectionId)?.ws).toBe(newWs);
    });

    it('should not unregister new connection when old connection closes', () => {
      const oldWs = new MockWebSocket() as unknown as WebSocket;
      const newWs = new MockWebSocket() as unknown as WebSocket;
      const connectionId = 'conn-123';
      const dbSessionId = 'session-456';

      // Register old connection
      chatConnectionService.register(connectionId, {
        ws: oldWs,
        dbSessionId,
        workingDir: '/test/dir',
      });

      // New connection comes in and replaces old one
      chatConnectionService.register(connectionId, {
        ws: newWs,
        dbSessionId,
        workingDir: '/test/dir',
      });

      // Simulate old connection's close handler checking if it should unregister
      const current = chatConnectionService.get(connectionId);

      // Old connection should NOT unregister because current ws is different
      if (current?.ws === oldWs) {
        chatConnectionService.unregister(connectionId);
      }

      // New connection should still be registered
      expect(chatConnectionService.has(connectionId)).toBe(true);
      expect(chatConnectionService.get(connectionId)?.ws).toBe(newWs);
    });

    it('should unregister connection when it is the current one', () => {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const connectionId = 'conn-123';
      const dbSessionId = 'session-456';

      // Register connection
      chatConnectionService.register(connectionId, {
        ws,
        dbSessionId,
        workingDir: '/test/dir',
      });

      // Simulate close handler checking if it should unregister
      const current = chatConnectionService.get(connectionId);

      // Should unregister because current ws matches
      if (current?.ws === ws) {
        chatConnectionService.unregister(connectionId);
      }

      // Connection should be unregistered
      expect(chatConnectionService.has(connectionId)).toBe(false);
    });
  });

  describe('message forwarding', () => {
    it('should forward message to all connections viewing a session', () => {
      const ws1 = new MockWebSocket() as unknown as WebSocket;
      const ws2 = new MockWebSocket() as unknown as WebSocket;
      const dbSessionId = 'session-456';

      chatConnectionService.register('conn-1', {
        ws: ws1,
        dbSessionId,
        workingDir: '/test/dir',
      });

      chatConnectionService.register('conn-2', {
        ws: ws2,
        dbSessionId,
        workingDir: '/test/dir',
      });

      const message = { type: 'test', data: 'hello' };
      chatConnectionService.forwardToSession(dbSessionId, message);

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(message));
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it('should not forward to connections with different session', () => {
      const ws1 = new MockWebSocket() as unknown as WebSocket;
      const ws2 = new MockWebSocket() as unknown as WebSocket;

      chatConnectionService.register('conn-1', {
        ws: ws1,
        dbSessionId: 'session-456',
        workingDir: '/test/dir',
      });

      chatConnectionService.register('conn-2', {
        ws: ws2,
        dbSessionId: 'session-789',
        workingDir: '/test/dir',
      });

      const message = { type: 'test', data: 'hello' };
      chatConnectionService.forwardToSession('session-456', message);

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(message));
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('should not forward to closed connections', () => {
      const mockWs = new MockWebSocket();
      mockWs.setReadyState(WS_READY_STATE.CLOSED);
      const ws = mockWs as unknown as WebSocket;

      chatConnectionService.register('conn-1', {
        ws,
        dbSessionId: 'session-456',
        workingDir: '/test/dir',
      });

      const message = { type: 'test', data: 'hello' };
      chatConnectionService.forwardToSession('session-456', message);

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should exclude specified websocket from forwarding', () => {
      const ws1 = new MockWebSocket() as unknown as WebSocket;
      const ws2 = new MockWebSocket() as unknown as WebSocket;
      const dbSessionId = 'session-456';

      chatConnectionService.register('conn-1', {
        ws: ws1,
        dbSessionId,
        workingDir: '/test/dir',
      });

      chatConnectionService.register('conn-2', {
        ws: ws2,
        dbSessionId,
        workingDir: '/test/dir',
      });

      const message = { type: 'test', data: 'hello' };
      chatConnectionService.forwardToSession(dbSessionId, message, ws1);

      expect(ws1.send).not.toHaveBeenCalled();
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(message));
    });
  });

  describe('session viewer counting', () => {
    it('counts only connections viewing the target session', () => {
      const sessionAConn1 = new MockWebSocket() as unknown as WebSocket;
      const sessionAConn2 = new MockWebSocket() as unknown as WebSocket;
      const sessionBConn = new MockWebSocket() as unknown as WebSocket;

      chatConnectionService.register('conn-a1', {
        ws: sessionAConn1,
        dbSessionId: 'session-a',
        workingDir: '/test/a',
      });
      chatConnectionService.register('conn-a2', {
        ws: sessionAConn2,
        dbSessionId: 'session-a',
        workingDir: '/test/a',
      });
      chatConnectionService.register('conn-b1', {
        ws: sessionBConn,
        dbSessionId: 'session-b',
        workingDir: '/test/b',
      });

      expect(chatConnectionService.countConnectionsViewingSession('session-a')).toBe(2);
      expect(chatConnectionService.countConnectionsViewingSession('session-b')).toBe(1);
      expect(chatConnectionService.countConnectionsViewingSession('session-c')).toBe(0);
      expect(chatConnectionService.countConnectionsViewingSession(null)).toBe(0);
    });
  });
});
