import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { createPostRunLogsUpgradeHandler, postRunLogsConnections } from './post-run-logs.handler';

class MockWebSocket extends EventEmitter {
  readyState: number = WS_READY_STATE.OPEN;
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

function createWssFromQueue(queue: MockWebSocket[]) {
  return {
    handleUpgrade: vi.fn(
      (
        _request: IncomingMessage,
        _socket: Duplex,
        _head: Buffer,
        callback: (socket: WebSocket) => void
      ) => {
        const ws = queue.shift();
        if (!ws) {
          throw new Error('No mock websocket available');
        }
        callback(ws as unknown as WebSocket);
      }
    ),
  } as unknown as WebSocketServer;
}

describe('createPostRunLogsUpgradeHandler', () => {
  beforeEach(() => {
    postRunLogsConnections.clear();
    vi.clearAllMocks();
  });

  it('rejects upgrades when workspaceId is missing', () => {
    const logger = createLogger();
    const runScriptService = {
      getPostRunOutputBuffer: vi.fn(() => ''),
      subscribeToPostRunOutput: vi.fn(),
    };
    const appContext = {
      services: {
        createLogger: vi.fn(() => logger),
        runScriptService,
      },
    } as unknown as AppContext;

    const handler = createPostRunLogsUpgradeHandler(appContext);
    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/post-run-logs'),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    expect(logger.warn).toHaveBeenCalledWith('Post-run logs WebSocket missing workspaceId');
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('streams buffered/live output and cleans up subscription on close', () => {
    const workspaceId = 'workspace-1';
    const logger = createLogger();
    const unsubscribe = vi.fn();
    let outputCallback: ((data: string) => void) | undefined;
    const runScriptService = {
      getPostRunOutputBuffer: vi.fn(() => 'buffered post-run logs\n'),
      subscribeToPostRunOutput: vi.fn((_id: string, callback: (data: string) => void) => {
        outputCallback = callback;
        return unsubscribe;
      }),
    };
    const appContext = {
      services: {
        createLogger: vi.fn(() => logger),
        runScriptService,
      },
    } as unknown as AppContext;

    const ws = new MockWebSocket();
    const handler = createPostRunLogsUpgradeHandler(appContext);
    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = createWssFromQueue([ws]);
    const wsAliveMap = new WeakMap<WebSocket, boolean>();

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL(`http://localhost/post-run-logs?workspaceId=${workspaceId}`),
      wss,
      wsAliveMap
    );

    expect(runScriptService.getPostRunOutputBuffer).toHaveBeenCalledWith(workspaceId);
    expect(runScriptService.subscribeToPostRunOutput).toHaveBeenCalledWith(
      workspaceId,
      expect.any(Function)
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'output', data: 'buffered post-run logs\n' })
    );
    expect(postRunLogsConnections.get(workspaceId)?.has(ws as unknown as WebSocket)).toBe(true);

    if (!outputCallback) {
      throw new Error('Expected output callback to be registered');
    }

    outputCallback('live output');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'output', data: 'live output' }));

    const sendsBeforeClosed = ws.send.mock.calls.length;
    ws.readyState = WS_READY_STATE.CLOSED;
    outputCallback('ignored output');
    expect(ws.send).toHaveBeenCalledTimes(sendsBeforeClosed);

    ws.emit('error', new Error('post-run socket failed'));
    expect(logger.error).toHaveBeenCalledWith(
      'Post-run logs WebSocket error',
      expect.objectContaining({ message: 'post-run socket failed' })
    );

    ws.emit('close');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(postRunLogsConnections.has(workspaceId)).toBe(false);
  });

  it('tracks multiple connections and only deletes workspace entry after the last close', () => {
    const workspaceId = 'workspace-2';
    const logger = createLogger();
    const unsubscribeFirst = vi.fn();
    const unsubscribeSecond = vi.fn();
    let subscribeCount = 0;
    const runScriptService = {
      getPostRunOutputBuffer: vi.fn(() => ''),
      subscribeToPostRunOutput: vi.fn(() => {
        subscribeCount += 1;
        return subscribeCount === 1 ? unsubscribeFirst : unsubscribeSecond;
      }),
    };
    const appContext = {
      services: {
        createLogger: vi.fn(() => logger),
        runScriptService,
      },
    } as unknown as AppContext;

    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();
    const handler = createPostRunLogsUpgradeHandler(appContext);
    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = createWssFromQueue([ws1, ws2]);
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL(`http://localhost/post-run-logs?workspaceId=${workspaceId}`);

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);
    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    expect(runScriptService.getPostRunOutputBuffer).toHaveBeenCalledTimes(2);
    expect(ws1.send).not.toHaveBeenCalled();
    expect(ws2.send).not.toHaveBeenCalled();
    expect(postRunLogsConnections.get(workspaceId)?.size).toBe(2);

    ws1.emit('close');
    expect(unsubscribeFirst).toHaveBeenCalledTimes(1);
    expect(postRunLogsConnections.get(workspaceId)?.size).toBe(1);

    ws2.emit('close');
    expect(unsubscribeSecond).toHaveBeenCalledTimes(1);
    expect(postRunLogsConnections.has(workspaceId)).toBe(false);
  });
});
