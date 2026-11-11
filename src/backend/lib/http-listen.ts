import type { Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';

/**
 * Addresses bound when no `BACKEND_HOST` is configured. Clients reach the
 * server as `localhost`, which resolves to either family (often `::1` first),
 * so both loopback addresses are bound and no other interface is.
 */
export const DEFAULT_LOOPBACK_ADDRESSES = { ipv4: '127.0.0.1', ipv6: '::1' } as const;

/** IPv6 is disabled or has no loopback address on this host. */
const IPV6_UNAVAILABLE_CODES: ReadonlySet<string> = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

/** Random-port (`0`) binds retry when the chosen port is taken on `::1`. */
const RANDOM_PORT_ATTEMPTS = 5;

export type CloseListeners = () => Promise<void>;

export interface HttpListenOptions {
  /** Called when `::1` cannot be bound because IPv6 is unavailable. */
  onIpv6Unavailable?: (errorCode: string) => void;
}

function getErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error && 'code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function listenOnce(server: NetServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);

    try {
      server.listen(port, host);
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

function closeNetServer(server: NetServer): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function getBoundPort(server: NetServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Listening server has no TCP address');
  }
  return address.port;
}

const closeNothing: CloseListeners = () => Promise.resolve();

/**
 * Listens on `::1` with a companion server that hands each accepted socket to
 * the HTTP server, so both loopback families share one request pipeline.
 */
async function listenOnIpv6Loopback(
  httpServer: HttpServer,
  port: number,
  options: HttpListenOptions
): Promise<CloseListeners> {
  const companion = createNetServer({ noDelay: true }, (socket) => {
    httpServer.emit('connection', socket);
  });
  try {
    await listenOnce(companion, port, DEFAULT_LOOPBACK_ADDRESSES.ipv6);
  } catch (error) {
    const code = getErrorCode(error);
    if (code !== undefined && IPV6_UNAVAILABLE_CODES.has(code)) {
      options.onIpv6Unavailable?.(code);
      return closeNothing;
    }
    throw error;
  }
  // Accept failures surface the same way as on the primary listener.
  companion.on('error', (error) => httpServer.emit('error', error));
  return () => closeNetServer(companion);
}

async function listenOnLoopback(
  httpServer: HttpServer,
  port: number,
  options: HttpListenOptions
): Promise<CloseListeners> {
  const attempts = port === 0 ? RANDOM_PORT_ATTEMPTS : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await listenOnce(httpServer, port, DEFAULT_LOOPBACK_ADDRESSES.ipv4);
    try {
      return await listenOnIpv6Loopback(httpServer, getBoundPort(httpServer), options);
    } catch (error) {
      // Release the IPv4 half so a port conflict on `::1` behaves like one on
      // `127.0.0.1`: the caller sees EADDRINUSE and can try another port.
      await closeNetServer(httpServer);
      lastError = error;
      if (getErrorCode(error) !== 'EADDRINUSE') {
        throw error;
      }
    }
  }
  throw lastError;
}

/**
 * Starts `httpServer` listening on `port`. An explicit `host` is bound as
 * given (for example `0.0.0.0` in Docker). Without one the server binds
 * loopback only, on both `127.0.0.1` and `::1`, rather than Node's default of
 * every interface. Returns a function that closes any companion listener; the
 * caller still closes `httpServer` itself.
 */
export function listenHttpServer(
  httpServer: HttpServer,
  port: number,
  host: string | undefined,
  options: HttpListenOptions = {}
): Promise<CloseListeners> {
  if (host !== undefined) {
    return listenOnce(httpServer, port, host).then(() => closeNothing);
  }
  return listenOnLoopback(httpServer, port, options);
}
