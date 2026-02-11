import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import { WS_READY_STATE } from '@/backend/constants';
import type { AppContext } from '../../app-context';
import { createDevLogsUpgradeHandler } from './dev-logs.handler';

class MockWebSocket extends EventEmitter {
  readyState: number = WS_READY_STATE.OPEN;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
}

describe('createDevLogsUpgradeHandler', () => {
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

    const request = {} as IncomingMessage;
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
