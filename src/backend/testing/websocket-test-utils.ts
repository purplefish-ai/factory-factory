import type { IncomingMessage } from 'node:http';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  wss: WebSocketServer,
  wsAliveMap: WeakMap<WebSocket, boolean>
) => void;

export interface WebSocketTestServer {
  close: () => Promise<void>;
  port: number;
}

export async function createWebSocketTestServer(
  handler: UpgradeHandler,
  allowedPath: string
): Promise<WebSocketTestServer> {
  const wss = new WebSocketServer({ noServer: true });
  const wsAliveMap = new WeakMap<WebSocket, boolean>();
  const server: HttpServer = createServer();

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname !== allowedPath) {
      socket.destroy();
      return;
    }
    handler(request, socket, head, url, wss, wsAliveMap);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server port');
  }

  return {
    port: (address as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close((wssError) => {
          if (wssError) {
            reject(wssError);
            return;
          }
          server.close((serverError) => {
            if (serverError) {
              reject(serverError);
              return;
            }
            resolve();
          });
        });
      }),
  };
}

export async function connectWebSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ws.off('open', onOpen);
      ws.off('error', onError);
    };

    ws.on('open', onOpen);
    ws.on('error', onError);
  });

  return ws;
}

export async function waitForWebSocketMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      try {
        resolve(JSON.parse(toMessageString(data)));
      } catch (error) {
        reject(error);
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };

    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

export async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 1000);

    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });

    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'test complete');
      return;
    }

    ws.terminate();
  });
}

function toMessageString(data: WebSocket.RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString();
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString();
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString();
  }
  return String(data);
}
