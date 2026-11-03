import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUpstreamHeaders,
  type PortForwarder,
  rewriteLocation,
  startPortForwarder,
} from './port-forwarder';

const publicOrigin = 'https://mac.tail123.ts.net:6173';

describe('buildUpstreamHeaders', () => {
  const target = { upstreamHost: '127.0.0.1', upstreamPort: 6173, publicOrigin };

  it('presents requests as local while keeping the client address', () => {
    const headers = buildUpstreamHeaders(
      {
        host: 'mac.tail123.ts.net:6173',
        origin: publicOrigin,
        referer: `${publicOrigin}/iframe.html`,
        'x-forwarded-for': '100.64.0.2',
        'tailscale-user-login': 'me@example.com',
        'tailscale-user-name': 'Me',
        connection: 'keep-alive',
      },
      target,
      '127.0.0.1'
    );
    expect(headers).toEqual({
      host: 'localhost:6173',
      origin: 'http://localhost:6173',
      referer: 'http://localhost:6173/iframe.html',
      'x-forwarded-for': '100.64.0.2',
    });
  });

  it('adds a client address when Serve did not, and leaves foreign origins alone', () => {
    const headers = buildUpstreamHeaders({ origin: 'https://evil.example' }, target, '127.0.0.1');
    expect(headers.origin).toBe('https://evil.example');
    expect(headers['x-forwarded-for']).toBe('127.0.0.1');
  });
});

describe('rewriteLocation', () => {
  const target = { upstreamHost: '127.0.0.1', upstreamPort: 6173, publicOrigin };

  it.each([
    ['http://localhost:6173/next', `${publicOrigin}/next`],
    ['http://127.0.0.1:6173', publicOrigin],
    ['http://[::1]:6173?x=1', `${publicOrigin}?x=1`],
    ['http://localhost:61730/next', 'http://localhost:61730/next'],
    ['/relative', '/relative'],
    ['https://example.com/', 'https://example.com/'],
  ])('rewrites %s to %s', (location, expected) => {
    expect(rewriteLocation(location, target)).toBe(expected);
  });
});

describe('startPortForwarder', () => {
  let upstream: Server | undefined;
  let forwarder: PortForwarder | undefined;
  const upgraded = new Set<import('node:stream').Duplex>();

  afterEach(async () => {
    await forwarder?.close();
    forwarder = undefined;
    for (const socket of upgraded) {
      socket.destroy();
    }
    upgraded.clear();
    if (upstream?.listening) {
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream?.close(resolve));
    }
    upstream = undefined;
  });

  async function startUpstream(): Promise<number> {
    upstream = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://localhost:${port}/landing` });
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: req.url, headers: req.headers }));
    });
    upstream.on('upgrade', (req, socket) => {
      upgraded.add(socket);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Host: ${req.headers.host}\r\n\r\n`
      );
      socket.on('data', (chunk) => socket.write(chunk));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('no address');
    }
    const port = address.port;
    return port;
  }

  it('forwards HTTP with local Host and maps upstream redirects to the share', async () => {
    const upstreamPort = await startUpstream();
    const origin = `https://mac.tail123.ts.net:${upstreamPort}`;
    forwarder = await startPortForwarder({
      upstreamHost: '127.0.0.1',
      upstreamPort,
      publicOrigin: origin,
    });
    const response = await fetch(`http://127.0.0.1:${forwarder.port}/iframe.html?x=1`, {
      headers: { 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.64.0.2' },
    });
    const body = (await response.json()) as { url: string; headers: IncomingHttpHeaders };
    expect(body.url).toBe('/iframe.html?x=1');
    expect(body.headers.host).toBe(`localhost:${upstreamPort}`);
    expect(body.headers['x-forwarded-for']).toBe('100.64.0.2');
    expect(body.headers['tailscale-user-login']).toBeUndefined();

    const redirect = await fetch(`http://127.0.0.1:${forwarder.port}/redirect`, {
      redirect: 'manual',
    });
    expect(redirect.headers.get('location')).toBe(`${origin}/landing`);
  });

  it('forwards WebSocket upgrades with local Host', async () => {
    const upstreamPort = await startUpstream();
    forwarder = await startPortForwarder({
      upstreamHost: '127.0.0.1',
      upstreamPort,
      publicOrigin,
    });
    const socket = connect(forwarder.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      'GET /hmr HTTP/1.1\r\nHost: mac.tail123.ts.net:6173\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
    );
    const [handshake] = (await once(socket, 'data')) as [Buffer];
    expect(handshake.toString()).toContain('101 Switching Protocols');
    expect(handshake.toString()).toContain(`X-Seen-Host: localhost:${upstreamPort}`);
    socket.write('ping');
    const [echo] = (await once(socket, 'data')) as [Buffer];
    expect(echo.toString()).toBe('ping');
    socket.destroy();
  });

  it('explains when nothing is listening upstream', async () => {
    const upstreamPort = await startUpstream();
    upstream?.close();
    forwarder = await startPortForwarder({
      upstreamHost: '127.0.0.1',
      upstreamPort,
      publicOrigin,
    });
    const response = await fetch(`http://127.0.0.1:${forwarder.port}/`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain(`Nothing is responding on port ${upstreamPort}`);
  });
});
