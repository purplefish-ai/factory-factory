import { z } from 'zod';

/**
 * Transport frames shared by every WebSocket channel, below the channel
 * schemas: a version hello from the server and an application-level ping the
 * server answers with a pong. Browsers answer the server's protocol pings but
 * cannot observe them, so a half-open connection needs these to be detected.
 *
 * Compatibility with the release before them, in both directions:
 * - A client opts in by adding `TRANSPORT_QUERY_PARAM=TRANSPORT_PROTOCOL` to
 *   the upgrade URL. Servers ignore query parameters they do not read, so an
 *   old server simply sends no hello.
 * - A server sends transport frames only to a client that opted in, so a tab
 *   from an older release never receives a frame its channel schemas reject.
 * - A client pings only after the hello, so an old server, which would answer
 *   an unknown frame with a channel error, never receives one.
 *
 * Every transport frame is a JSON object whose `TRANSPORT_FRAME_KEY` names its
 * kind. No channel frame has that key, so neither side can mistake one for
 * the other; channel frames discriminate on `type`.
 */
export const TRANSPORT_QUERY_PARAM = 'ffTransport';
export const TRANSPORT_PROTOCOL = '1';
export const TRANSPORT_FRAME_KEY = 'ffTransport';

export const TransportHelloSchema = z.object({
  ffTransport: z.literal('hello'),
  /** The server's package version, the one identifier client and server share. */
  version: z.string(),
});

export const TransportPingSchema = z.object({
  ffTransport: z.literal('ping'),
  id: z.number().int().nonnegative(),
});

export const TransportPongSchema = z.object({
  ffTransport: z.literal('pong'),
  id: z.number().int().nonnegative(),
});

export const TransportServerFrameSchema = z.discriminatedUnion('ffTransport', [
  TransportHelloSchema,
  TransportPongSchema,
]);

export type TransportHello = z.infer<typeof TransportHelloSchema>;
export type TransportPing = z.infer<typeof TransportPingSchema>;
export type TransportPong = z.infer<typeof TransportPongSchema>;

/**
 * The serialized prefix of every ping, `{"ffTransport":"ping"`, which the
 * client writes with this key first. The server checks it before parsing, so
 * channel frames are not parsed twice.
 */
export const TRANSPORT_PING_PREFIX = '{"ffTransport":"ping"';

export function createTransportPing(id: number): TransportPing {
  return { ffTransport: 'ping', id };
}

/** Whether a parsed frame belongs to the transport rather than to a channel. */
export function isTransportFrame(value: unknown): boolean {
  return typeof value === 'object' && value !== null && TRANSPORT_FRAME_KEY in value;
}

/** Adds the transport opt-in to a root-absolute or absolute WebSocket URL. */
export function withTransportOptIn(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${TRANSPORT_QUERY_PARAM}=${TRANSPORT_PROTOCOL}`;
}
