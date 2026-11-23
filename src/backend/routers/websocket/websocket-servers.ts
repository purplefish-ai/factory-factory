import { type PerMessageDeflateOptions, type WebSocket, WebSocketServer } from 'ws';

/**
 * `permessage-deflate` for the channels that send large JSON frames.
 *
 * - No context takeover in either direction. `ws` ignores `threshold` when the
 *   server keeps its context, so every frame, however small, would wait for
 *   the libuv threadpool, which zlib shares with `fs`, DNS and crypto. On
 *   loopback with four busy threadpool jobs, a compressed 64-byte echo took
 *   150 ms at the median against 0.4 ms uncompressed. Context takeover would
 *   shrink live deltas to a fifth, but they are at most about ten small
 *   frames a second.
 * - `threshold`: live `/chat` frames are 120 B to 2.4 KB; they stay
 *   uncompressed and off the threadpool. Metadata, replay chunks, snapshots and
 *   log replays are larger and compress to a quarter or less.
 * - Window bits are left to negotiation (15 unless the client asks for less).
 *   A numeric `serverMaxWindowBits`/`clientMaxWindowBits` makes `ws` answer
 *   400 to an offer it cannot satisfy, such as one without
 *   `client_max_window_bits`, instead of falling back to no compression.
 * - zlib level 6 (its default) costs about 2 ms per 128 KB replay chunk and
 *   its output is 14% smaller than level 1's; `memLevel` 7 halves the hash
 *   table at no measured cost in ratio.
 * - Memory per compressing connection, allocated on first use and held until
 *   close (`ws` resets rather than frees zlib state between messages): deflate
 *   2^17 + 2^16 = 192 KiB, plus about 39 KiB of inflate state once the client
 *   sends a compressed message (Chromium compresses every message it sends).
 * - `concurrencyLimit` caps concurrent zlib jobs from `ws` so they hold at
 *   most half of the default four threadpool threads. `ws` keeps this limiter
 *   process-wide and sizes it from the first instance created.
 *
 * Byte budgets (`bufferedAmount`) count a frame at its uncompressed size while
 * it waits for zlib and at its compressed size once it is queued on the socket.
 * Frame size limits (`WEBSOCKET_MAX_FRAME_BYTES`, `MAX_REPLAY_FRAME_BYTES`)
 * still apply to the uncompressed message the browser receives.
 */
const PER_MESSAGE_DEFLATE: PerMessageDeflateOptions = {
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  threshold: 4 * 1024,
  zlibDeflateOptions: { level: 6, memLevel: 7 },
  concurrencyLimit: 2,
};

/**
 * Channels that negotiate compression. The rest do not: `/voice` carries
 * audio, and the terminals are interactive, so each keystroke the browser
 * compressed would wait for the threadpool to be inflated, while their only
 * large frame is the scrollback (at most 100 KB) sent on connect.
 */
const COMPRESSED_PATHS: ReadonlySet<string> = new Set([
  '/chat',
  '/snapshots',
  '/dev-logs',
  '/post-run-logs',
]);

export interface WebSocketServers {
  /** The server that accepts upgrades for a path. */
  forPath(pathname: string): WebSocketServer;
  /** Open clients of every server, for the heartbeat. */
  clients(): WebSocket[];
  /** Terminates every client and closes both servers. */
  close(): Promise<void>;
}

export function createWebSocketServers(): WebSocketServers {
  const compressed = new WebSocketServer({
    noServer: true,
    perMessageDeflate: PER_MESSAGE_DEFLATE,
  });
  const plain = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const servers = [compressed, plain];
  const clients = () => servers.flatMap((server) => [...server.clients]);
  return {
    forPath: (pathname) => (COMPRESSED_PATHS.has(pathname) ? compressed : plain),
    clients,
    close: async () => {
      for (const ws of clients()) {
        ws.terminate();
      }
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      );
    },
  };
}
