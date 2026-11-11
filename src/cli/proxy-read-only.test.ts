import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect } from 'node:net';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppContext } from '@/backend/app-context';
import { createContext, publicProcedure, router, trustedLocalProcedure } from '@/backend/trpc/trpc';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { ListeningLocalProxy } from './proxy-listen';
import { createReadOnlyProxy } from './proxy-read-only';

const TUNNEL_HEADERS = {
  host: 'random-words.trycloudflare.com',
  'cf-connecting-ip': '203.0.113.10',
  'x-forwarded-for': '203.0.113.10',
};

interface Upstream {
  server: Server;
  port: number;
  calls: string[];
  upgrades: number;
}

/** The backend's HTTP stack as `server.ts` mounts it, with stand-in procedures. */
async function startUpstream(): Promise<Upstream> {
  const calls: string[] = [];
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: router({
        // Stand-ins for session.createAndStartSession and workspace files.readFile.
        startSession: publicProcedure.input(z.object({ workspaceId: z.string() })).mutation(() => {
          calls.push('startSession');
          return 'started';
        }),
        execute: trustedLocalProcedure.mutation(() => {
          calls.push('execute');
          return 'executed';
        }),
        trustedRead: trustedLocalProcedure.query(() => {
          calls.push('trustedRead');
          return 'trusted';
        }),
        readFile: publicProcedure.input(z.object({ path: z.string() })).query(({ input }) => {
          calls.push('readFile');
          return `contents of ${input.path}`;
        }),
      }),
      createContext: createContext(
        unsafeCoerce<AppContext>({
          services: {
            configService: {
              getCorsConfig: () => ({
                allowedOrigins: ['http://localhost:3001'],
                trustedLocalCidrs: [],
                trustProxyHeaders: false,
                disableCorsChecks: false,
                // As `ff proxy` launches it: the backend's own loopback origin passes.
                allowOwnLoopbackOrigin: true,
              }),
              getBackendHost: () => '127.0.0.1',
            },
          },
        })
      ),
    })
  );
  const server = createServer(app);
  const upstream = { server, port: 0, calls, upgrades: 0 };
  server.on('upgrade', (_req, socket) => {
    upstream.upgrades += 1;
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing upstream address');
  }
  upstream.port = address.port;
  return upstream;
}

function trpcInput(input: unknown): string {
  return encodeURIComponent(JSON.stringify({ json: input }));
}

function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload));
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.on('close', () => resolve(response));
    socket.on('error', reject);
  });
}

describe('public read-only tunnel proxy', () => {
  let upstream: Upstream;
  let proxy: ListeningLocalProxy;
  let client: ReturnType<typeof request>;

  beforeEach(async () => {
    upstream = await startUpstream();
    proxy = await createReadOnlyProxy({ upstreamPort: upstream.port });
    client = request(`http://127.0.0.1:${proxy.port}`);
  });

  afterEach(async () => {
    await proxy.close();
    upstream.server.closeAllConnections();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  it('forwards queries and other GETs, including from the tunnel hostname', async () => {
    const read = await client
      .get(`/api/trpc/readFile?input=${trpcInput({ path: 'README.md' })}`)
      .set(TUNNEL_HEADERS);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ result: { data: { json: 'contents of README.md' } } });

    const batch = await client
      .get(
        `/api/trpc/readFile,readFile?batch=1&input=${encodeURIComponent(
          JSON.stringify({ 0: { json: { path: 'a' } }, 1: { json: { path: 'b' } } })
        )}`
      )
      .set(TUNNEL_HEADERS);
    expect(batch.status).toBe(200);

    const health = await client.get('/health').set(TUNNEL_HEADERS);
    expect(health.status).toBe(200);
    expect(upstream.calls).toEqual(['readFile', 'readFile', 'readFile']);
  });

  it('answers HEAD without running a procedure', async () => {
    const head = await client
      .head(`/api/trpc/startSession?input=${trpcInput({ workspaceId: 'w1' })}`)
      .set(TUNNEL_HEADERS);
    expect(head.status).toBeLessThan(300);
    expect(upstream.calls).toEqual([]);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)(
    'refuses %s without forwarding, whatever the headers',
    async (method) => {
      const response = await client[method.toLowerCase() as 'post']('/api/trpc/startSession')
        .set({
          // Neither an allowed Origin nor a missing one gets a mutation through.
          origin: 'http://localhost:3001',
          'x-http-method-override': 'GET',
          'content-type': 'application/json',
        })
        .send({ json: { workspaceId: 'w1' } });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('GET, HEAD');
      expect(upstream.calls).toEqual([]);
    }
  );

  it('refuses a tunnelled mutation and upgrade carrying the backend loopback Origin', async () => {
    const loopbackOrigin = `http://localhost:${upstream.port}`;
    // The backend alone accepts its own loopback origin, so only the proxy stops it.
    const direct = await request(`http://127.0.0.1:${upstream.port}`)
      .post('/api/trpc/startSession')
      .set('origin', loopbackOrigin)
      .send({ json: { workspaceId: 'direct' } });
    expect(direct.status).toBe(200);
    upstream.calls.length = 0;

    const response = await client
      .post('/api/trpc/startSession')
      .set({ ...TUNNEL_HEADERS, origin: loopbackOrigin })
      .send({ json: { workspaceId: 'w1' } });
    expect(response.status).toBe(405);

    const upgrade = await rawExchange(
      proxy.port,
      [
        'GET /chat HTTP/1.1',
        `Host: localhost:${upstream.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `Origin: ${loopbackOrigin}`,
        '',
        '',
      ].join('\r\n')
    );
    expect(upgrade).toMatch(/^HTTP\/1\.1 403 /);
    expect(upstream.calls).toEqual([]);
    expect(upstream.upgrades).toBe(0);
  });

  it('refuses CONNECT without opening an upstream connection', async () => {
    const response = await rawExchange(
      proxy.port,
      `CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n\r\n`
    );
    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(upstream.calls).toEqual([]);
    expect(upstream.upgrades).toBe(0);
  });

  it.each([
    '/api/trpc/admin.exportData',
    '/API/TRPC/admin.exportData',
    '/api/trpc/extra/admin.exportData',
    '/api/trpc/admin%2EexportData',
    '/api/./trpc/admin.exportData',
    `/api/trpc/readFile,session.listSubagents?batch=1`,
  ])('refuses blocked queries however the path is spelled: %s', async (path) => {
    const response = await client.get(path).set(TUNNEL_HEADERS);
    expect(response.status).toBe(403);
    expect(upstream.calls).toEqual([]);
  });

  it('refuses paths whose procedure segment cannot be decoded', async () => {
    const response = await client.get('/api/trpc/readFile%E0%A4%A').set(TUNNEL_HEADERS);
    expect(response.status).toBe(400);
  });

  it('refuses an Origin-less POST mutation from the tunnel', async () => {
    const response = await client
      .post('/api/trpc/startSession')
      .set(TUNNEL_HEADERS)
      .send({ json: { workspaceId: 'w1' } });
    expect(response.status).toBe(405);
    expect(upstream.calls).toEqual([]);
  });

  it('does not run mutations requested over GET, alone or batched', async () => {
    const single = await client
      .get(`/api/trpc/startSession?input=${trpcInput({ workspaceId: 'w1' })}`)
      .set(TUNNEL_HEADERS);
    expect(single.status).toBe(405);

    const batched = await client
      .get(
        `/api/trpc/startSession,execute?batch=1&input=${encodeURIComponent(
          JSON.stringify({ 0: { json: { workspaceId: 'w1' } }, 1: { json: null } })
        )}`
      )
      .set(TUNNEL_HEADERS);
    expect(batched.status).toBeGreaterThanOrEqual(400);

    const mixed = await client
      .get(
        `/api/trpc/readFile,startSession?batch=1&input=${encodeURIComponent(
          JSON.stringify({ 0: { json: { path: 'a' } }, 1: { json: { workspaceId: 'w1' } } })
        )}`
      )
      .set(TUNNEL_HEADERS);
    expect(mixed.status).toBeGreaterThanOrEqual(400);
    expect(upstream.calls).not.toContain('startSession');
    expect(upstream.calls).not.toContain('execute');
  });

  it('marks every request as remote so trusted-local procedures refuse it', async () => {
    const response = await client.get('/api/trpc/trustedRead');
    expect(response.status).toBe(403);
    expect(upstream.calls).toEqual([]);
  });

  it('refuses GET requests that carry a body', async () => {
    const withLength = await rawExchange(
      proxy.port,
      'GET /api/trpc/readFile HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}'
    );
    expect(withLength).toMatch(/^HTTP\/1\.1 400 /);

    const chunked = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: proxy.port, method: 'GET', path: '/health' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.setHeader('transfer-encoding', 'chunked');
      req.end('{}');
    });
    expect(chunked).toBe(400);
    expect(upstream.calls).toEqual([]);
  });

  it.each([
    ['/chat', 'http://localhost:3001'],
    ['/terminal', 'https://random-words.trycloudflare.com'],
    ['/api/trpc', undefined],
  ])('refuses WebSocket upgrades to %s (Origin %s)', async (path, origin) => {
    const response = await rawExchange(
      proxy.port,
      [
        `GET ${path} HTTP/1.1`,
        'Host: random-words.trycloudflare.com',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...(origin ? [`Origin: ${origin}`] : []),
        '',
        '',
      ].join('\r\n')
    );
    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(upstream.upgrades).toBe(0);
  });
});
