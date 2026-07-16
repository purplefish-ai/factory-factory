/**
 * Tests for ChatConnectionRegistry
 *
 * Covers connection lifecycle, reconnection race scenarios, per-session
 * fan-out, viewer counting, and session event bus wiring.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { WS_READY_STATE, type WsReadyState } from '@/backend/constants/websocket';
import {
  SESSION_OUTBOUND_EVENT,
  type SessionFileLogger,
  sessionEventBus,
} from '@/backend/services/session';
import type { WebSocketMessage } from '@/shared/acp-protocol';
import {
  attachChatTransport,
  ChatConnectionRegistry,
  type ConnectionInfo,
  chatConnectionRegistry,
  detachChatTransportForTests,
} from './chat-connection-registry';

vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: {
    log: vi.fn(),
  },
}));

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

function asWs(mock: MockWebSocket): WebSocket {
  return mock as unknown as WebSocket;
}

function asMessage(payload: object): WebSocketMessage {
  return payload as WebSocketMessage;
}

describe('ChatConnectionRegistry', () => {
  let registry: ChatConnectionRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ChatConnectionRegistry();
  });

  describe('connection registration', () => {
    it('registers and unregisters a connection', () => {
      const info: ConnectionInfo = {
        ws: asWs(new MockWebSocket()),
        dbSessionId: 'session-456',
        workingDir: '/test/dir',
      };

      registry.register('conn-123', info);
      expect(registry.has('conn-123')).toBe(true);
      expect(registry.get('conn-123')).toBe(info);
      expect(registry.countViewers('session-456')).toBe(1);

      registry.unregister('conn-123');
      expect(registry.has('conn-123')).toBe(false);
      expect(registry.get('conn-123')).toBeUndefined();
      expect(registry.countViewers('session-456')).toBe(0);
    });

    it('does not index connections without a session', () => {
      registry.register('conn-123', {
        ws: asWs(new MockWebSocket()),
        dbSessionId: null,
        workingDir: null,
      });

      expect(registry.has('conn-123')).toBe(true);
      expect(registry.countViewers(null)).toBe(0);
    });
  });

  describe('reconnection race condition', () => {
    it('replaces old connection when same connectionId reconnects', () => {
      const oldWs = asWs(new MockWebSocket());
      const newWs = asWs(new MockWebSocket());

      registry.register('conn-123', { ws: oldWs, dbSessionId: 's1', workingDir: null });
      expect(registry.get('conn-123')?.ws).toBe(oldWs);

      registry.register('conn-123', { ws: newWs, dbSessionId: 's1', workingDir: null });
      expect(registry.get('conn-123')?.ws).toBe(newWs);
      // The replaced socket must not linger in the session index.
      expect(registry.countViewers('s1')).toBe(1);
    });

    it('does not unregister new connection when old connection closes', () => {
      const oldWs = asWs(new MockWebSocket());
      const newWs = asWs(new MockWebSocket());

      registry.register('conn-123', { ws: oldWs, dbSessionId: 's1', workingDir: null });
      registry.register('conn-123', { ws: newWs, dbSessionId: 's1', workingDir: null });

      // Simulate old connection's close handler checking before unregistering.
      const current = registry.get('conn-123');
      if (current?.ws === oldWs) {
        registry.unregister('conn-123');
      }

      expect(registry.has('conn-123')).toBe(true);
      expect(registry.get('conn-123')?.ws).toBe(newWs);
      expect(registry.countViewers('s1')).toBe(1);
    });
  });

  describe('broadcastToSession', () => {
    it('forwards message to all connections viewing a session', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      registry.register('conn-1', { ws: asWs(ws1), dbSessionId: 's1', workingDir: null });
      registry.register('conn-2', { ws: asWs(ws2), dbSessionId: 's1', workingDir: null });

      const message = asMessage({ type: 'test', data: 'hello' });
      registry.broadcastToSession('s1', message);

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(message));
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it('does not forward to connections viewing a different session', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      registry.register('conn-1', { ws: asWs(ws1), dbSessionId: 's1', workingDir: null });
      registry.register('conn-2', { ws: asWs(ws2), dbSessionId: 's2', workingDir: null });

      registry.broadcastToSession('s1', asMessage({ type: 'test' }));

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('does not forward to closed connections', () => {
      const ws = new MockWebSocket();
      ws.setReadyState(WS_READY_STATE.CLOSED);

      registry.register('conn-1', { ws: asWs(ws), dbSessionId: 's1', workingDir: null });
      registry.broadcastToSession('s1', asMessage({ type: 'test' }));

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('continues forwarding to remaining connections when a send throws', () => {
      const throwingWs = new MockWebSocket();
      throwingWs.send.mockImplementation(() => {
        throw new Error('socket closing');
      });
      const healthyWs = new MockWebSocket();

      registry.register('conn-1', { ws: asWs(throwingWs), dbSessionId: 's1', workingDir: null });
      registry.register('conn-2', { ws: asWs(healthyWs), dbSessionId: 's1', workingDir: null });

      const message = asMessage({ type: 'test', data: 'hello' });
      expect(() => registry.broadcastToSession('s1', message)).not.toThrow();

      expect(throwingWs.send).toHaveBeenCalled();
      expect(healthyWs.send).toHaveBeenCalledWith(JSON.stringify(message));
    });
  });

  describe('broadcastToAll', () => {
    it('sends to every connection regardless of session', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      const noSessionWs = new MockWebSocket();

      registry.register('conn-1', { ws: asWs(ws1), dbSessionId: 's1', workingDir: null });
      registry.register('conn-2', { ws: asWs(ws2), dbSessionId: 's2', workingDir: null });
      registry.register('conn-3', { ws: asWs(noSessionWs), dbSessionId: null, workingDir: null });

      const payload = { type: 'workspace_notification_request' };
      registry.broadcastToAll(payload);

      const message = JSON.stringify(payload);
      expect(ws1.send).toHaveBeenCalledWith(message);
      expect(ws2.send).toHaveBeenCalledWith(message);
      expect(noSessionWs.send).toHaveBeenCalledWith(message);
    });
  });

  describe('viewer counting', () => {
    it('counts only connections viewing the target session', () => {
      registry.register('conn-a1', {
        ws: asWs(new MockWebSocket()),
        dbSessionId: 'session-a',
        workingDir: null,
      });
      registry.register('conn-a2', {
        ws: asWs(new MockWebSocket()),
        dbSessionId: 'session-a',
        workingDir: null,
      });
      registry.register('conn-b1', {
        ws: asWs(new MockWebSocket()),
        dbSessionId: 'session-b',
        workingDir: null,
      });

      expect(registry.countViewers('session-a')).toBe(2);
      expect(registry.countViewers('session-b')).toBe(1);
      expect(registry.countViewers('session-c')).toBe(0);
      expect(registry.countViewers(null)).toBe(0);
    });
  });
});

describe('attachChatTransport', () => {
  afterEach(() => {
    detachChatTransportForTests();
  });

  it('delivers session events published on the bus to viewing connections', () => {
    attachChatTransport();

    const ws = new MockWebSocket();
    chatConnectionRegistry.register('conn-1', {
      ws: asWs(ws),
      dbSessionId: 's1',
      workingDir: null,
    });

    const payload = asMessage({ type: 'session_delta', data: { type: 'noop' } });
    sessionEventBus.publishToSession('s1', payload);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(payload));
  });

  it('delivers all-client broadcasts published on the bus', () => {
    attachChatTransport();

    const ws = new MockWebSocket();
    chatConnectionRegistry.register('conn-1', {
      ws: asWs(ws),
      dbSessionId: null,
      workingDir: null,
    });

    sessionEventBus.publishToAllClients({ type: 'workspace_notification_request' });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'workspace_notification_request' })
    );
  });

  it('answers viewer-count queries from the domain', () => {
    attachChatTransport();

    expect(sessionEventBus.countViewers('s1')).toBe(0);

    chatConnectionRegistry.register('conn-1', {
      ws: asWs(new MockWebSocket()),
      dbSessionId: 's1',
      workingDir: null,
    });

    expect(sessionEventBus.countViewers('s1')).toBe(1);
  });

  it('is idempotent and does not double-deliver after repeated attach', () => {
    attachChatTransport();
    attachChatTransport();

    const ws = new MockWebSocket();
    chatConnectionRegistry.register('conn-1', {
      ws: asWs(ws),
      dbSessionId: 's1',
      workingDir: null,
    });

    sessionEventBus.publishToSession(
      's1',
      asMessage({ type: 'session_delta', data: { type: 'noop' } })
    );

    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('logs OUT_TO_CLIENT via the injected sessionFileLogger only when a client received the payload', () => {
    const fileLogger = { log: vi.fn() };
    attachChatTransport({ sessionFileLogger: fileLogger as unknown as SessionFileLogger });

    const payload = asMessage({ type: 'session_delta', data: { type: 'noop' } });
    sessionEventBus.publishToSession('s1', payload);
    expect(fileLogger.log).not.toHaveBeenCalled();

    chatConnectionRegistry.register('conn-1', {
      ws: asWs(new MockWebSocket()),
      dbSessionId: 's1',
      workingDir: null,
    });
    sessionEventBus.publishToSession('s1', payload);

    expect(fileLogger.log).toHaveBeenCalledWith('s1', 'OUT_TO_CLIENT', payload);
  });

  it('detach removes only its own bus listeners', () => {
    const unrelatedListener = vi.fn();
    sessionEventBus.on(SESSION_OUTBOUND_EVENT, unrelatedListener);
    try {
      attachChatTransport();
      detachChatTransportForTests();

      sessionEventBus.publishToSession(
        's1',
        asMessage({ type: 'session_delta', data: { type: 'noop' } })
      );

      expect(unrelatedListener).toHaveBeenCalledTimes(1);
    } finally {
      sessionEventBus.off(SESSION_OUTBOUND_EVENT, unrelatedListener);
    }
  });
});
