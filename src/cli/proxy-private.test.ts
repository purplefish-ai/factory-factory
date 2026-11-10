import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { shouldAllowOwnLoopbackOrigin } from '@/backend/lib/request-trust';
import { createWebSocketUpgradeHandler } from '@/backend/routers/websocket/upgrade-utils';
import type { CorsConfig } from '@/backend/services/config.service';
import { createContext, publicProcedure, router, trustedLocalProcedure } from '@/backend/trpc/trpc';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { proxyInternals } from './proxy';
import { GLOBAL_PASSWORD_FAILURE_LIMIT } from './proxy-brute-force';

const TUNNEL_URL = 'https://quiet-river.trycloudflare.com';
const TUNNEL_ORIGIN = TUNNEL_URL;
const PASSWORD = 'ABC123';
const TOKEN = 'test-auth-token';
const CLIENT_HEADERS = { 'cf-connecting-ip': '203.0.113.10', 'x-forwarded-for': '203.0.113.10' };

interface Upstream {
  server: Server;
  port: number;
  state: { reads: number; writes: number; privileged: number };
  /** Headers of every request and upgrade that reached the backend. */
  seen: IncomingHttpHeaders[];
  /** Upgraded sockets leave the HTTP server's connection tracking. */
  upgradedSockets: Set<Duplex>;
}

/** The backend as `ff proxy` launches it: loopback bind, default loopback origins. */
async function startUpstream(): Promise<Upstream> {
  const allowedOrigins = ['http://localhost:3000', 'http://localhost:3001'];
  const corsConfig: CorsConfig = {
    allowedOrigins,
    trustedLocalCidrs: [],
    trustProxyHeaders: false,
    disableCorsChecks: false,
    allowOwnLoopbackOrigin: shouldAllowOwnLoopbackOrigin('127.0.0.1', allowedOrigins),
  };
  const configService = { getCorsConfig: () => corsConfig, getBackendHost: () => '127.0.0.1' };
  const upstream: Upstream = {
    server: createServer(),
    port: 0,
    state: { reads: 0, writes: 0, privileged: 0 },
    seen: [],
    upgradedSockets: new Set(),
  };
  const { state } = upstream;

  const app = express();
  app.use((req, _res, next) => {
    upstream.seen.push(req.headers);
    next();
  });
  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: router({
        read: publicProcedure.query(() => ++state.reads),
        write: publicProcedure.mutation(() => ++state.writes),
        privileged: trustedLocalProcedure.mutation(() => ++state.privileged),
      }),
      createContext: createContext(unsafeCoerce<AppContext>({ services: { configService } })),
    })
  );
  upstream.server.on('request', app);

  // The real WebSocket preamble: Origin check, then trusted-local check.
  const logger = { warn: () => undefined, error: () => undefined };
  const handleChat = createWebSocketUpgradeHandler({
    connectionName: 'chat',
    configService,
    logger,
    onOpen: (ws) => ws.send('hello'),
  });
  const wss = new WebSocketServer({ noServer: true });
  const wsAliveMap = new WeakMap<WebSocket, boolean>();
  upstream.server.on('upgrade', (req, socket, head) => {
    upstream.seen.push(req.headers);
    upstream.upgradedSockets.add(socket);
    handleChat(req, socket, head, new URL(req.url ?? '/', 'http://localhost'), wss, wsAliveMap);
  });

  upstream.server.listen(0, '127.0.0.1');
  await once(upstream.server, 'listening');
  const address = upstream.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing upstream address');
  }
  upstream.port = address.port;
  return upstream;
}

/** Opens a WebSocket through the proxy; resolves with `open` or the refusal status. */
function openWebSocket(port: number, headers: Record<string, string>): Promise<string | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chat`, { headers });
    ws.once('message', (data) => {
      resolve(`open:${data.toString()}`);
      ws.close();
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.once('error', reject);
  });
}

function getSessionCookie(setCookie: string[] | string | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first?.split(';')[0] ?? '';
}

describe('password-protected tunnel proxy', () => {
  let upstream: Upstream;
  let proxy: Awaited<ReturnType<typeof proxyInternals.createAuthProxy>>;
  let client: ReturnType<typeof request>;

  beforeEach(async () => {
    upstream = await startUpstream();
    proxy = await proxyInternals.createAuthProxy({
      upstreamPort: upstream.port,
      password: PASSWORD,
      magicToken: TOKEN,
    });
    client = request(`http://127.0.0.1:${proxy.port}`);
  });

  afterEach(async () => {
    await proxy.close();
    for (const socket of upstream.upgradedSockets) {
      socket.destroy();
    }
    upstream.server.closeAllConnections();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  async function signIn(ip = '198.51.100.1'): Promise<string> {
    const response = await client
      .post('/__proxy_auth/login')
      .type('form')
      .set({ 'cf-connecting-ip': ip, origin: TUNNEL_ORIGIN })
      .send({ password: PASSWORD });
    expect(response.status).toBe(302);
    return getSessionCookie(response.headers['set-cookie']);
  }

  function mutate(path: 'write' | 'privileged', headers: Record<string, string>) {
    return client
      .post(`/api/trpc/${path}`)
      .set({ ...CLIENT_HEADERS, ...headers })
      .send({ json: null });
  }

  it('sets a host-only, Secure, HttpOnly, SameSite session cookie', async () => {
    proxy.setTunnelUrl(TUNNEL_URL);
    const response = await client
      .post('/__proxy_auth/login')
      .type('form')
      .send({ password: PASSWORD });
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-ff_proxy_session=[0-9a-f]+\.[0-9a-f]+;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('forwards authenticated mutations, including trusted-local ones, as same-origin', async () => {
    proxy.setTunnelUrl(TUNNEL_URL);
    const cookie = await signIn();

    expect((await mutate('write', { cookie, origin: TUNNEL_ORIGIN })).status).toBe(200);
    expect((await mutate('privileged', { cookie, origin: TUNNEL_ORIGIN })).status).toBe(200);
    expect(upstream.state).toMatchObject({ writes: 1, privileged: 1 });

    const forwarded = upstream.seen.at(-1);
    expect(forwarded?.origin).toBe(`http://localhost:${upstream.port}`);
    expect(forwarded?.host).toBe(`localhost:${upstream.port}`);
    expect(forwarded?.['cf-connecting-ip']).toBeUndefined();
    expect(forwarded?.['x-forwarded-for']).toBeUndefined();
    expect(forwarded?.cookie).toBeUndefined();
  });

  it('opens an authenticated WebSocket from the tunnel origin', async () => {
    proxy.setTunnelUrl(TUNNEL_URL);
    const cookie = await signIn();

    await expect(
      openWebSocket(proxy.port, { ...CLIENT_HEADERS, cookie, origin: TUNNEL_ORIGIN })
    ).resolves.toBe('open:hello');
    // The direct link authenticates an upgrade too.
    const viaToken = await new Promise<string | number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/chat?token=${TOKEN}`, {
        headers: { origin: TUNNEL_ORIGIN },
      });
      ws.once('message', (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.once('error', reject);
    });
    expect(viaToken).toBe('hello');
    expect(upstream.seen.at(-1)?.origin).toBe(`http://localhost:${upstream.port}`);
  });

  it.each([
    'https://other-tunnel.trycloudflare.com',
    'https://quiet-river.trycloudflare.com.evil.example',
    'http://quiet-river.trycloudflare.com',
    // The backend accepts its own loopback origin, so only the proxy can refuse it.
    'BACKEND_ORIGIN',
    'null',
  ])('refuses an authenticated request from Origin %s', async (rawOrigin) => {
    proxy.setTunnelUrl(TUNNEL_URL);
    const cookie = await signIn();
    const origin = rawOrigin === 'BACKEND_ORIGIN' ? `http://localhost:${upstream.port}` : rawOrigin;

    expect((await mutate('write', { cookie, origin })).status).toBe(403);
    expect((await mutate('privileged', { cookie, origin })).status).toBe(403);
    await expect(openWebSocket(proxy.port, { cookie, origin })).resolves.toBe(403);
    expect(upstream.state).toMatchObject({ writes: 0, privileged: 0 });
    expect(upstream.seen).toEqual([]);
  });

  it('refuses state changes and upgrades without an Origin but serves plain reads', async () => {
    proxy.setTunnelUrl(TUNNEL_URL);
    const cookie = await signIn();

    expect((await mutate('write', { cookie })).status).toBe(403);
    await expect(openWebSocket(proxy.port, { cookie })).resolves.toBe(403);
    const read = await client.get('/api/trpc/read').set({ ...CLIENT_HEADERS, cookie });
    expect(read.status).toBe(200);
    expect(upstream.state).toMatchObject({ reads: 1, writes: 0 });
  });

  it('refuses unauthenticated mutations and upgrades from the tunnel origin', async () => {
    proxy.setTunnelUrl(TUNNEL_URL);
    const mutation = await mutate('write', { origin: TUNNEL_ORIGIN });
    expect(mutation.type).toBe('text/html');
    expect(mutation.text).toContain('Enter Access Code');

    const forged = 'ff_proxy_session=x.y; __Host-ff_proxy_session=abc.def';
    expect((await mutate('privileged', { origin: TUNNEL_ORIGIN, cookie: forged })).type).toBe(
      'text/html'
    );
    await expect(openWebSocket(proxy.port, { origin: TUNNEL_ORIGIN })).resolves.toBe(401);
    await expect(
      openWebSocket(proxy.port, { origin: TUNNEL_ORIGIN, cookie: forged })
    ).resolves.toBe(401);
    expect(upstream.state).toMatchObject({ writes: 0, privileged: 0 });
    expect(upstream.seen).toEqual([]);
  });

  it('refuses requests carrying an Origin until the tunnel URL is known', async () => {
    const cookie = await signIn();

    expect((await mutate('write', { cookie, origin: TUNNEL_ORIGIN })).status).toBe(503);
    await expect(openWebSocket(proxy.port, { cookie, origin: TUNNEL_ORIGIN })).resolves.toBe(503);
    expect((await client.get('/api/trpc/read').set({ cookie })).status).toBe(200);

    proxy.setTunnelUrl(TUNNEL_URL);
    expect((await mutate('write', { cookie, origin: TUNNEL_ORIGIN })).status).toBe(200);
  });

  it('locks password sign-in for every client after repeated failures', async () => {
    proxy.setTunnelUrl(TUNNEL_URL);
    const cookie = await signIn();

    // Each failure comes from a different address, so the per-IP limit never applies.
    for (let i = 0; i < GLOBAL_PASSWORD_FAILURE_LIMIT; i += 1) {
      const failed = await client
        .post('/__proxy_auth/login')
        .type('form')
        .set('cf-connecting-ip', `203.0.113.${i + 1}`)
        .send({ password: 'BAD000' });
      expect(failed.status).toBe(401);
    }

    const locked = await client
      .post('/__proxy_auth/login')
      .type('form')
      .set('cf-connecting-ip', '192.0.2.200')
      .send({ password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.headers['set-cookie']).toBeUndefined();

    // Signed-in sessions and the direct link keep working.
    expect((await mutate('write', { cookie, origin: TUNNEL_ORIGIN })).status).toBe(200);
    const viaToken = await client
      .get(`/api/trpc/read?token=${TOKEN}`)
      .set('cf-connecting-ip', '192.0.2.201');
    expect(viaToken.status).toBe(200);
  });
});
