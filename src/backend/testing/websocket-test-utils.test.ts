import { afterEach, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import {
  closeWebSocket,
  connectWebSocket,
  createWebSocketTestServer,
  type WebSocketTestServer,
  waitForWebSocketMessage,
} from './websocket-test-utils';

let server: WebSocketTestServer | undefined;
let ws: WebSocket | undefined;
afterEach(async () => {
  try {
    if (ws) {
      await closeWebSocket(ws);
    }
  } finally {
    await server?.close();
    ws = undefined;
    server = undefined;
  }
});

async function connectResponder(respond: (client: WebSocket) => void): Promise<WebSocket> {
  server = await createWebSocketTestServer((request, socket, head, _url, wss) => {
    wss.handleUpgrade(request, socket, head, (client) => {
      client.on('message', () => respond(client));
    });
  }, '/terminal');
  ws = await connectWebSocket(`ws://127.0.0.1:${server.port}/terminal`);
  return ws;
}

it('waits for created after an initial terminal list over a real WebSocket', async () => {
  const created = { type: 'created', terminalId: 'terminal-1' };
  const client = await connectResponder((socket) => {
    socket.send(JSON.stringify({ type: 'terminal_list', terminals: [] }));
    socket.send(JSON.stringify(created));
  });
  const messageSchema = z.object({ type: z.literal('created') });
  const received: unknown[] = [];
  const response = waitForWebSocketMessage(client, 2000, (message) => {
    received.push(message);
    return messageSchema.safeParse(message).success;
  });
  client.send(JSON.stringify({ type: 'create' }));
  await expect(response).resolves.toEqual(created);
  expect(received).toEqual([{ type: 'terminal_list', terminals: [] }, created]);
  expect(client.listenerCount('message')).toBe(0);
  expect(client.listenerCount('error')).toBe(0);
});

it('rejects and cleans up when the socket closes before the matching event', async () => {
  const client = await connectResponder((socket) => {
    socket.send(JSON.stringify({ type: 'terminal_list', terminals: [] }));
    socket.close();
  });
  const response = waitForWebSocketMessage(client, 2000, () => false);
  client.send(JSON.stringify({ type: 'create' }));
  await expect(response).rejects.toThrow('WebSocket closed before the expected message');
  expect(client.listenerCount('message')).toBe(0);
  expect(client.listenerCount('error')).toBe(0);
  expect(client.listenerCount('close')).toBe(0);
});

it('retains a bounded deadline when received messages do not match', async () => {
  const client = await connectResponder((socket) => {
    socket.send(JSON.stringify({ type: 'terminal_list', terminals: [] }));
  });
  const response = waitForWebSocketMessage(client, 25, () => false);
  client.send(JSON.stringify({ type: 'create' }));
  await expect(response).rejects.toThrow('Timed out waiting for WebSocket message after 25ms');
  expect(client.listenerCount('message')).toBe(0);
  expect(client.listenerCount('error')).toBe(0);
  expect(client.listenerCount('close')).toBe(0);
});

it('cleans up and preserves an error thrown by the predicate', async () => {
  const client = await connectResponder((socket) => {
    socket.send(JSON.stringify({ type: 'created', terminalId: 'terminal-1' }));
  });
  const failure = new Error('Predicate failed');
  const response = waitForWebSocketMessage(client, 2000, () => {
    throw failure;
  });
  client.send(JSON.stringify({ type: 'create' }));
  await expect(response).rejects.toBe(failure);
  expect(client.listenerCount('message')).toBe(0);
  expect(client.listenerCount('error')).toBe(0);
  expect(client.listenerCount('close')).toBe(0);
});
