import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { sendStateful } from '@/backend/lib/websocket-send';
import { closeWebSocket } from '@/backend/testing/websocket-test-utils';
import { proxyAuthenticatedWebSocketUpgrade } from '@/shared/proxy-utils';
import { createWebSocketServers, type WebSocketServers } from './websocket-servers';

interface Harness {
  port: number;
  /** The server's side of the next accepted connection, with its raw socket. */
  accepted: () => Promise<{ ws: WebSocket; socket: Socket }>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function start(): Promise<Harness & { servers: WebSocketServers }> {
  const servers = createWebSocketServers();
  const http: Server = createServer();
  const waiting: ((value: { ws: WebSocket; socket: Socket }) => void)[] = [];
  http.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    servers.forPath(pathname).handleUpgrade(request, socket, head, (ws) => {
      waiting.shift()?.({ ws, socket: socket as Socket });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(async () => {
    await servers.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return {
    servers,
    port: (http.address() as AddressInfo).port,
    accepted: () => new Promise((resolve) => waiting.push(resolve)),
  };
}

/** Puts the `ff proxy` upgrade forwarder in front of a harness. */
async function behindFfProxy<T extends Harness>(harness: T): Promise<T> {
  const proxy = createServer();
  proxy.on('upgrade', (req, socket, head) => {
    proxyAuthenticatedWebSocketUpgrade({
      req,
      socket,
      head,
      upstreamPort: harness.port,
      sanitizedPath: req.url ?? '/',
      sessionCookieName: 'session',
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  return { ...harness, port: (proxy.address() as AddressInfo).port };
}

async function open(
  harness: Harness,
  path: string,
  offersDeflate: boolean
): Promise<{ client: WebSocket; server: WebSocket; socket: Socket; agreed: string }> {
  const accepted = harness.accepted();
  // The default `ws` client offers `permessage-deflate; client_max_window_bits`,
  // as Chromium does.
  const client = new WebSocket(`ws://127.0.0.1:${harness.port}${path}`, {
    perMessageDeflate: offersDeflate,
  });
  cleanups.push(() => closeWebSocket(client));
  const response = new Promise<IncomingMessage>((resolve) => client.once('upgrade', resolve));
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  const { ws: server, socket } = await accepted;
  return {
    client,
    server,
    socket,
    agreed: (await response).headers['sec-websocket-extensions'] ?? '',
  };
}

function nextMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    client.once('message', (data: Buffer) => resolve(data.toString()));
  });
}

function messages(client: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    const received: string[] = [];
    const onMessage = (data: Buffer) => {
      received.push(data.toString());
      if (received.length === count) {
        client.off('message', onMessage);
        resolve(received);
      }
    };
    client.on('message', onMessage);
  });
}

/** Replay-shaped JSON: repeated envelopes around varied text, like a transcript. */
function replayFrame(bytes: number): string {
  const events: unknown[] = [];
  let size = 0;
  for (let index = 0; size < bytes - 400; index++) {
    const event = {
      type: 'agent_message',
      order: index,
      data: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `Step ${index}: checked ${index * 7919} rows in table_${index % 13}.`,
            },
          ],
        },
      },
    };
    size += JSON.stringify(event).length + 1;
    events.push(event);
  }
  const frame = JSON.stringify({
    type: 'session_replay_chunk',
    replayId: 'r1',
    index: 0,
    total: 1,
    events,
  });
  return frame.slice(0, bytes);
}

function writtenBy(socket: Socket, send: () => void, client: WebSocket): Promise<number> {
  const before = socket.bytesWritten;
  const received = nextMessage(client);
  send();
  return received.then(() => socket.bytesWritten - before);
}

describe('WebSocket servers', () => {
  it.each(['/chat', '/snapshots', '/dev-logs', '/post-run-logs'])(
    'negotiates permessage-deflate on %s without context takeover',
    async (path) => {
      const harness = await start();
      const { client, agreed } = await open(harness, path, true);
      expect(client.extensions).toBe('permessage-deflate');
      expect(agreed).toBe(
        'permessage-deflate; server_no_context_takeover; client_no_context_takeover'
      );
    }
  );

  it.each(['/terminal', '/setup-terminal', '/voice', '/unknown'])(
    'does not negotiate compression on %s even when the client offers it',
    async (path) => {
      const harness = await start();
      const { client, server, agreed } = await open(harness, path, true);
      expect(client.extensions).toBe('');
      expect(agreed).toBe('');
      const payload = 'a'.repeat(64 * 1024);
      const received = nextMessage(client);
      server.send(payload);
      expect(await received).toBe(payload);
    }
  );

  it('round-trips a replay-sized frame compressed for a client that offers the extension', async () => {
    const harness = await start();
    const { client, server, socket } = await open(harness, '/chat', true);
    const frame = replayFrame(128 * 1024);
    const received = nextMessage(client);
    const written = await writtenBy(socket, () => server.send(frame), client);
    expect(await received).toBe(frame);
    expect(written).toBeLessThan(Buffer.byteLength(frame) / 4);
  });

  it('negotiates through the ff proxy, which forwards the extension headers', async () => {
    const harness = await behindFfProxy(await start());
    const { client, server, socket, agreed } = await open(harness, '/chat', true);
    expect(agreed).toContain('permessage-deflate');
    const frame = replayFrame(128 * 1024);
    const received = nextMessage(client);
    const written = await writtenBy(socket, () => server.send(frame), client);
    expect(await received).toBe(frame);
    expect(written).toBeLessThan(Buffer.byteLength(frame) / 4);
  });

  it('serves a client that does not offer the extension uncompressed', async () => {
    const harness = await start();
    const { client, server, socket } = await open(harness, '/chat', false);
    expect(client.extensions).toBe('');
    const frame = replayFrame(128 * 1024);
    const received = nextMessage(client);
    const written = await writtenBy(socket, () => server.send(frame), client);
    expect(await received).toBe(frame);
    // Payload plus the 10-byte header of a 64-bit length frame.
    expect(written).toBe(Buffer.byteLength(frame) + 10);
  });

  it('sends live-sized frames uncompressed below the threshold', async () => {
    const harness = await start();
    const { client, server, socket } = await open(harness, '/chat', true);
    const delta = JSON.stringify({ type: 'session_delta', text: 'a'.repeat(3000) });
    const written = await writtenBy(socket, () => server.send(delta), client);
    // Payload plus the 4-byte header of a 16-bit length frame: not deflated.
    expect(written).toBe(Buffer.byteLength(delta) + 4);
  });

  it('admits a large authoritative frame queued behind a frame that is still being compressed', async () => {
    const harness = await start();
    const { client, server } = await open(harness, '/chat', true);
    const logger = { error: vi.fn() };
    const metadata = replayFrame(42 * 1024);
    const baseline = replayFrame(2 * 1024 * 1024);
    const flushed: string[] = [];
    const received = messages(client, 2);
    expect(
      sendStateful(server, metadata, logger, 'metadata', {
        onFlushed: () => flushed.push('metadata'),
      })
    ).toBe(true);
    // Compression is asynchronous, so the socket is not empty yet.
    expect(server.bufferedAmount).toBeGreaterThan(0);
    expect(
      sendStateful(server, baseline, logger, 'baseline', {
        allowLargeFrame: true,
        onFlushed: () => flushed.push('baseline'),
      })
    ).toBe(true);
    expect(await received).toEqual([metadata, baseline]);
    expect(flushed).toEqual(['metadata', 'baseline']);
    expect(logger.error).not.toHaveBeenCalled();
    expect(server.readyState).toBe(WebSocket.OPEN);
  });

  it('lists clients of both servers and terminates them on close', async () => {
    const harness = await start();
    const chat = await open(harness, '/chat', true);
    const terminal = await open(harness, '/terminal', true);
    expect(new Set(harness.servers.clients())).toEqual(new Set([chat.server, terminal.server]));
    const closed = Promise.all(
      [chat.client, terminal.client].map(
        (ws) => new Promise((resolve) => ws.once('close', resolve))
      )
    );
    await harness.servers.close();
    await closed;
    expect([...harness.servers.clients()]).toEqual([]);
  });
});
