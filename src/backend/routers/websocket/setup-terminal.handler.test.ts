import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { createSetupTerminalUpgradeHandler } from './setup-terminal.handler';

class MockWebSocket extends EventEmitter {
  readyState = WS_READY_STATE.OPEN;
  send = vi.fn();
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('createSetupTerminalUpgradeHandler', () => {
  it('rejects messages that fail schema validation', () => {
    const logger = createLogger();
    const appContext = {
      services: {
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;

    const handler = createSetupTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = {
      handleUpgrade: vi.fn(
        (
          _request: IncomingMessage,
          _socket: Duplex,
          _head: Buffer,
          callback: (socket: WebSocket) => void
        ) => callback(ws as unknown as WebSocket)
      ),
    } as unknown as WebSocketServer;
    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/setup-terminal'),
      wss,
      wsAliveMap
    );

    ws.emit('message', JSON.stringify({ type: 'resize', cols: '120', rows: 40 }));

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Invalid message format' })
    );
  });
});
