import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { createDevLogsUpgradeHandler } from './dev-logs.handler';

const allowedOrigin = 'http://localhost:3000';

class MockWebSocket extends EventEmitter {
  readyState: number = WS_READY_STATE.OPEN;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
}

describe('createDevLogsUpgradeHandler', () => {
  it('rejects unauthorized origins before checking workspaceId', () => {
    const runScriptService = {
      getOutputBuffer: vi.fn(() => ''),
      subscribeToOutput: vi.fn(),
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const appContext = {
      services: {
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
        runScriptService,
      },
    } as unknown as AppContext;

    const handler = createDevLogsUpgradeHandler(appContext);
    const request = { headers: { origin: 'https://attacker.example' } } as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/dev-logs'),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Unauthorized origin'));
    expect(logger.warn).not.toHaveBeenCalledWith('Dev logs WebSocket missing workspaceId');
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('rejects untrusted remote addresses before opening a WebSocket', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const appContext = {
      services: {
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin], trustedLocalCidrs: [] })),
        },
        createLogger: vi.fn(() => logger),
        runScriptService: {
          getOutputBuffer: vi.fn(() => ''),
          subscribeToOutput: vi.fn(),
        },
      },
    } as unknown as AppContext;

    const handler = createDevLogsUpgradeHandler(appContext);
    const request = {
      headers: { origin: allowedOrigin },
      socket: { remoteAddress: '203.0.113.10' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/dev-logs?workspaceId=workspace-1'),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Untrusted remote address'));
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('rejects forwarded local upgrades before opening a WebSocket', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const appContext = {
      services: {
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin], trustedLocalCidrs: [] })),
        },
        createLogger: vi.fn(() => logger),
        runScriptService: {
          getOutputBuffer: vi.fn(() => ''),
          subscribeToOutput: vi.fn(),
        },
      },
    } as unknown as AppContext;

    const handler = createDevLogsUpgradeHandler(appContext);
    const request = {
      headers: { origin: allowedOrigin, 'x-forwarded-for': '203.0.113.10' },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/dev-logs?workspaceId=workspace-1'),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(
      expect.stringContaining('Forwarded WebSocket upgrades are not trusted')
    );
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('streams buffered and live output only while socket is open', () => {
    const workspaceId = 'workspace-1';

    const runScriptService = {
      getOutputBuffer: vi.fn(() => 'buffered logs\n'),
      subscribeToOutput: vi.fn((_id: string, _callback: (data: string) => void) => vi.fn()),
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const appContext = {
      services: {
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
        runScriptService,
      },
    } as unknown as AppContext;

    const handler = createDevLogsUpgradeHandler(appContext);
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

    const request = {
      headers: { origin: allowedOrigin },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL(`http://localhost/dev-logs?workspaceId=${workspaceId}`);

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'output', data: 'buffered logs\n' })
    );
    const outputSubscriber = runScriptService.subscribeToOutput.mock.calls[0]?.[1] as
      | ((data: string) => void)
      | undefined;
    if (!outputSubscriber) {
      throw new Error('Expected subscribeToOutput callback to be registered');
    }
    outputSubscriber('live logs\n');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'output', data: 'live logs\n' }));

    const callsBeforeClosed = ws.send.mock.calls.length;
    ws.readyState = WS_READY_STATE.CLOSED;
    outputSubscriber('dropped logs\n');
    expect(ws.send.mock.calls.length).toBe(callsBeforeClosed);
  });
});
