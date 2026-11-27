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
const PING_PREFIX_BYTES = Buffer.from(TRANSPORT_PING_PREFIX, 'utf8');

/** Whether the client asked for transport frames in its upgrade URL. */
export function wantsTransportFrames(url: URL): boolean {
  return url.searchParams.get(TRANSPORT_QUERY_PARAM) === TRANSPORT_PROTOCOL;
}

/**
 * `null` when the frame belongs to the channel; otherwise the ping's id, or
 * `'malformed'` for a frame with the ping prefix that does not parse, which is
 * dropped so that no channel handler sees a transport frame.
 */
function readPing(data: unknown, isBinary: unknown): number | 'malformed' | null {
  if (isBinary === true || !Buffer.isBuffer(data)) {
    return null;
  }
  // A channel frame is never mistaken for one: none has the transport key.
  if (!data.subarray(0, TRANSPORT_PING_PREFIX.length).equals(PING_PREFIX_BYTES)) {
    return null;
  }
  if (data.length > MAX_PING_FRAME_BYTES) {
    return 'malformed';
  }
  try {
    const ping = TransportPingSchema.safeParse(JSON.parse(data.toString('utf8')));
    return ping.success ? ping.data.id : 'malformed';
  } catch {
    return 'malformed';
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
        if (id !== 'malformed' && ws.readyState === ws.OPEN) {
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
