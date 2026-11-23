import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ApplicationServices } from '@/backend/app-context';
import { SessionEventBus } from '@/backend/services/session';
import { closeWebSocket, connectWebSocket } from '@/backend/testing/websocket-test-utils';
import type { WebSocketMessage } from '@/shared/acp-protocol';
import { SessionReplayAssembler } from '@/shared/acp-protocol/protocol/replay-framing';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  attachChatTransport,
  ChatConnectionRegistry,
  detachChatTransport,
} from './chat-connection-registry';
import { frameSessionReplay } from './session-replay-framing';
import { createWebSocketServers } from './websocket-servers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A chat transport whose one viewer is a real `/chat` socket. */
async function viewChat(offersDeflate: boolean) {
  const servers = createWebSocketServers();
  const http = createServer();
  const accepted = new Promise<{ ws: WebSocket; socket: Socket }>((resolve) => {
    http.on('upgrade', (request, socket, head) => {
      servers.forPath('/chat').handleUpgrade(request, socket, head, (ws) => {
        resolve({ ws, socket: socket as Socket });
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(async () => {
    await servers.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const client = await connectWebSocket(
    `ws://127.0.0.1:${(http.address() as AddressInfo).port}/chat`,
    { perMessageDeflate: offersDeflate }
  );
  cleanups.push(() => closeWebSocket(client));
  const { ws, socket } = await accepted;

  const registry = new ChatConnectionRegistry();
  const bus = new SessionEventBus();
  attachChatTransport(
    unsafeCoerce<
      Pick<
        ApplicationServices,
        'configService' | 'createLogger' | 'sessionEventBus' | 'sessionFileLogger'
      >
    >({
      configService: {
        getDebugConfig: () => ({ chatWebSocket: false }),
        getWebSocketConfig: () => ({ maxFrameBytes: 32 * 1024 * 1024 }),
      },
      createLogger: () => ({ error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
      sessionEventBus: bus,
      sessionFileLogger: { log: vi.fn() },
    }),
    registry
  );
  cleanups.push(() => detachChatTransport(registry));
  registry.register('v1', { ws, dbSessionId: 's1', workingDir: null });
  registry.expectReplay(ws, 'load-1');
  return { bus, client, server: ws, socket };
}

/** About 1 MB of transcript-like events, so the replay goes out in chunks. */
function replay(): Extract<WebSocketMessage, { type: 'session_replay_batch' }> {
  return {
    type: 'session_replay_batch',
    loadRequestId: 'load-1',
    replayEvents: Array.from({ length: 4000 }, (_, index) => ({
      type: 'assistant_text_delta' as const,
      messageId: `m${Math.floor(index / 40)}`,
      order: index,
      offset: (index % 40) * 240,
      text: `Checked ${index * 7919} rows in table_${index % 13}; the ${index % 2 ? 'index' : 'scan'} path took ${index % 97} ms. `.repeat(
        2
      ),
    })),
  };
}

const delta: WebSocketMessage = {
  type: 'session_delta',
  data: { type: 'slash_commands', slashCommands: [] },
};

it.each([true, false])(
  'delivers a chunked replay and the delta after it over /chat (client offers deflate: %s)',
  async (offersDeflate) => {
    const { bus, client, server, socket } = await viewChat(offersDeflate);
    expect(client.extensions).toBe(offersDeflate ? 'permessage-deflate' : '');
    const batch = replay();
    const frames = [...frameSessionReplay(batch)];
    expect(frames.length).toBeGreaterThan(4);
    const assembler = new SessionReplayAssembler();
    const received = new Promise<unknown[]>((resolve) => {
      const messages: unknown[] = [];
      client.on('message', (data: Buffer) => {
        const message = assembler.accept(JSON.parse(data.toString()));
        if (message !== null) {
          messages.push(message);
        }
        if (messages.length === 2) {
          resolve(messages);
        }
      });
    });
    const before = socket.bytesWritten;
    for (const frame of frames) {
      bus.publishToSession('s1', frame.payload, frame.json);
    }
    bus.publishToSession('s1', delta);

    expect(await received).toEqual([batch, delta]);
    expect(server.readyState).toBe(WebSocket.OPEN);
    const payloadBytes =
      frames.reduce((total, frame) => total + Buffer.byteLength(frame.json), 0) +
      Buffer.byteLength(JSON.stringify(delta));
    const wireBytes = socket.bytesWritten - before;
    if (offersDeflate) {
      expect(wireBytes).toBeLessThan(payloadBytes / 4);
    } else {
      expect(wireBytes).toBeGreaterThan(payloadBytes);
    }
  }
);
