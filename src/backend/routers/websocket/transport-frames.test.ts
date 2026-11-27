import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  closeWebSocket,
  createWebSocketTestServer,
  type WebSocketTestServer,
  waitForWebSocketMessage,
} from '@/backend/testing/websocket-test-utils';
import { createWebSocketUpgradeHandler } from './upgrade-utils';

const ORIGIN = 'http://localhost:3000';

/**
 * A channel like the real ones: it validates every inbound frame and answers
 * anything it does not recognise with an error frame.
 */
function createStrictChannelServer(): Promise<WebSocketTestServer> {
  const handler = createWebSocketUpgradeHandler({
    connectionName: 'test WebSocket',
    configService: {
      getCorsConfig: () => ({
        allowedOrigins: [ORIGIN],
        trustedLocalCidrs: [],
        trustProxyHeaders: false,
        disableCorsChecks: false,
      }),
      getAppVersion: () => '1.2.3',
    },
    logger: { warn: () => undefined, error: () => undefined },
    onOpen: (ws) => {
      ws.send(JSON.stringify({ type: 'ready' }));
      ws.on('message', (data) => {
        const text = String(data);
        const isEcho = text.startsWith('{"type":"echo"');
        ws.send(JSON.stringify(isEcho ? JSON.parse(text) : { type: 'error', received: text }));
      });
    },
  });
  return createWebSocketTestServer(handler, '/channel');
}

function isEcho(message: unknown): boolean {
  return (
    typeof message === 'object' && message !== null && 'type' in message && message.type === 'echo'
  );
}

const open: WebSocket[] = [];
let server: WebSocketTestServer | null = null;

async function connect(query: string): Promise<{ ws: WebSocket; frames: unknown[] }> {
  if (!server) {
    throw new Error('Server not started');
  }
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/channel${query}`, {
    headers: { origin: ORIGIN },
  });
  open.push(ws);
  // Listen before the upgrade completes: the first frames follow it at once.
  const frames: unknown[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data))));
  await once(ws, 'open');
  return { ws, frames };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((ws) => closeWebSocket(ws)));
  await server?.close();
  server = null;
});

describe('transport frames', () => {
  it('greets an opted-in client with the version and answers pings below the channel', async () => {
    server = await createStrictChannelServer();
    const { ws, frames } = await connect('?ffTransport=1');

    ws.send(JSON.stringify({ ffTransport: 'ping', id: 7 }));
    ws.send(JSON.stringify({ type: 'echo', value: 'after the ping' }));
    await waitForWebSocketMessage(ws, 2000, isEcho);

    expect(frames).toEqual([
      { ffTransport: 'hello', version: '1.2.3' },
      { type: 'ready' },
      { ffTransport: 'pong', id: 7 },
      { type: 'echo', value: 'after the ping' },
    ]);
  });

  it('sends nothing new to a client from an older release', async () => {
    server = await createStrictChannelServer();
    const { ws, frames } = await connect('');

    ws.send(JSON.stringify({ type: 'echo', value: 'old client' }));
    await waitForWebSocketMessage(ws, 2000, isEcho);

    expect(frames).toEqual([{ type: 'ready' }, { type: 'echo', value: 'old client' }]);
  });
});
