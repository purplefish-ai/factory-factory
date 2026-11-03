import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request as httpRequest,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { removeHopByHopHeaders } from '@/shared/proxy-utils';

const FORWARDER_HOST = '127.0.0.1';

export interface PortForwarderTarget {
  /** Loopback address the upstream server listens on (`127.0.0.1` or `::1`). */
  upstreamHost: string;
  upstreamPort: number;
  /** Public origin of the share, e.g. `https://mac.tail123.ts.net:6173`. */
  publicOrigin: string;
}

export interface PortForwarder {
  port: number;
  close(): Promise<void>;
}

/**
 * Dev servers reject unknown hosts (Vite's `allowedHosts`), so the upstream
 * sees `localhost:<port>`. Client-address headers stay so other local Factory
 * Factory backends never mistake shared traffic for a local client; Tailscale
 * identity headers are dropped so dev servers do not learn the viewer's login.
 */
export function buildUpstreamHeaders(
  headers: IncomingHttpHeaders,
  target: PortForwarderTarget,
  remoteAddress: string | undefined
): OutgoingHttpHeaders {
  const upstream: OutgoingHttpHeaders = removeHopByHopHeaders(headers);
  for (const key of Object.keys(upstream)) {
    if (key.toLowerCase().startsWith('tailscale-')) {
      delete upstream[key];
    }
  }
  const localOrigin = `http://localhost:${target.upstreamPort}`;
  upstream.host = `localhost:${target.upstreamPort}`;
  if (upstream.origin === target.publicOrigin) {
    upstream.origin = localOrigin;
  }
  const referer = upstream.referer;
  if (typeof referer === 'string' && referer.startsWith(`${target.publicOrigin}/`)) {
    upstream.referer = `${localOrigin}${referer.slice(target.publicOrigin.length)}`;
  }
  if (upstream['x-forwarded-for'] === undefined) {
    upstream['x-forwarded-for'] = remoteAddress ?? FORWARDER_HOST;
  }
  return upstream;
}

/** Points upstream redirects to its own loopback address back at the share. */
export function rewriteLocation(location: string, target: PortForwarderTarget): string {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const prefix = `http://${host}:${target.upstreamPort}`;
    const rest = location.startsWith(prefix) ? location.slice(prefix.length) : null;
    if (rest !== null && (rest === '' || /^[/?#]/.test(rest))) {
      return `${target.publicOrigin}${rest}`;
    }
  }
  return location;
}

function serializeHeaders(headers: OutgoingHttpHeaders): string {
  return Object.entries(headers)
    .flatMap(([key, value]) => {
      if (value === undefined) {
        return [];
      }
      return (Array.isArray(value) ? value : [value]).map((item) => `${key}: ${item}\r\n`);
    })
    .join('');
}

function writeUnavailable(res: import('node:http').ServerResponse, port: number): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = 502;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(`Nothing is responding on port ${port} on the host. Start it, then reload.`);
}

/** Starts a loopback HTTP and WebSocket forwarder for one shared port. */
export function startPortForwarder(target: PortForwarderTarget): Promise<PortForwarder> {
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  const server = createServer((req: IncomingMessage, res) => {
    const upstreamRequest = httpRequest(
      {
        host: target.upstreamHost,
        port: target.upstreamPort,
        method: req.method,
        path: req.url,
        headers: buildUpstreamHeaders(req.headers, target, req.socket.remoteAddress),
      },
      (upstreamResponse) => {
        const headers = removeHopByHopHeaders(upstreamResponse.headers);
        if (typeof headers.location === 'string') {
          headers.location = rewriteLocation(headers.location, target);
        }
        res.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(res);
        upstreamResponse.once('error', () => res.destroy());
      }
    );
    upstreamRequest.once('error', () => writeUnavailable(res, target.upstreamPort));
    req.once('error', () => upstreamRequest.destroy());
    req.pipe(upstreamRequest);
  });

  server.on('connection', track);
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const upstream: Socket = connect({ host: target.upstreamHost, port: target.upstreamPort });
    track(upstream);
    upstream.once('connect', () => {
      const headers = buildUpstreamHeaders(req.headers, target, req.socket.remoteAddress);
      headers.connection = 'Upgrade';
      headers.upgrade = req.headers.upgrade;
      upstream.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n`);
      upstream.write(`${serializeHeaders(headers)}\r\n`);
      if (head.length > 0) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once('error', () => socket.destroy());
    socket.once('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, FORWARDER_HOST, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine port forwarder address'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
            for (const socket of sockets) {
              socket.destroy();
            }
          }),
      });
    });
  });
}
