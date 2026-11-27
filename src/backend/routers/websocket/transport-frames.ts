import type { WebSocket } from 'ws';
import {
  TRANSPORT_PING_PREFIX,
  TRANSPORT_PROTOCOL,
  TRANSPORT_QUERY_PARAM,
  type TransportHello,
  TransportPingSchema,
  type TransportPong,
} from '@/shared/websocket-transport';

/** Longest ping frame the server inspects; a real one is about 30 bytes. */
const MAX_PING_FRAME_BYTES = 64;

/** Whether the client asked for transport frames in its upgrade URL. */
export function wantsTransportFrames(url: URL): boolean {
  return url.searchParams.get(TRANSPORT_QUERY_PARAM) === TRANSPORT_PROTOCOL;
}

function readPing(data: unknown, isBinary: unknown): number | null {
  if (isBinary === true || !Buffer.isBuffer(data) || data.length > MAX_PING_FRAME_BYTES) {
    return null;
  }
  const text = data.toString('utf8');
  if (!text.startsWith(TRANSPORT_PING_PREFIX)) {
    return null;
  }
  try {
    const ping = TransportPingSchema.safeParse(JSON.parse(text));
    return ping.success ? ping.data.id : null;
  } catch {
    return null;
  }
}

/**
 * Sends the version hello and answers pings for a client that opted in.
 *
 * Called before the channel's `onOpen`, so the hello is the socket's first
 * frame. Pings are answered inside `emit`, before any `message` listener runs,
 * so no channel handler sees a transport frame and none of their schemas
 * needs to know about one.
 */
export function acceptTransportFrames(ws: WebSocket, serverVersion: string): void {
  const emit = ws.emit.bind(ws);
  ws.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'message') {
      const id = readPing(args[0], args[1]);
      if (id !== null) {
        if (ws.readyState === ws.OPEN) {
          const pong: TransportPong = { ffTransport: 'pong', id };
          ws.send(JSON.stringify(pong));
        }
        return true;
      }
    }
    return emit(event, ...args);
  };
  const hello: TransportHello = { ffTransport: 'hello', version: serverVersion };
  ws.send(JSON.stringify(hello));
}
