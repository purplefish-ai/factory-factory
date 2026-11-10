import { createServer } from 'node:http';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { shouldAllowOwnLoopbackOrigin } from '@/backend/lib/request-trust';
import type { CorsConfig } from '@/backend/services/config.service';
import { proxyInternals } from '@/cli/proxy';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createContext, publicProcedure, router, trustedLocalProcedure } from './trpc';

const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://localhost:3001'];

type GateOptions = {
  /** `BACKEND_HOST`; undefined binds loopback only. */
  backendHost?: string;
  cors?: Partial<CorsConfig>;
};

function createApp({ backendHost, cors }: GateOptions = {}) {
  const app = express();
  const state = { reads: 0, writes: 0, privileged: 0 };
  const allowedOrigins = cors?.allowedOrigins ?? DEFAULT_ORIGINS;
  const corsConfig: CorsConfig = {
    allowedOrigins,
    trustedLocalCidrs: [],
    trustProxyHeaders: false,
    disableCorsChecks: false,
    // As configService derives it.
    allowOwnLoopbackOrigin: shouldAllowOwnLoopbackOrigin(backendHost, allowedOrigins),
    ...cors,
  };
  const appContext = unsafeCoerce<AppContext>({
    services: {
      configService: {
        getCorsConfig: () => corsConfig,
        getBackendHost: () => backendHost,
      },
    },
  });
  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: router({
        read: publicProcedure.query(() => ++state.reads),
        write: publicProcedure.mutation(() => ++state.writes),
        privileged: trustedLocalProcedure.mutation(() => ++state.privileged),
      }),
      createContext: createContext(appContext),
    })
  );
  return { app, state };
}

type Headers = Record<string, string>;

function read(app: express.Express, headers: Headers = {}) {
  return request(app).get('/api/trpc/read').set(headers);
}

function write(app: express.Express, headers: Headers = {}, path = 'write') {
  return request(app).post(`/api/trpc/${path}`).send({ json: null }).set(headers);
}

/** Listens on an ephemeral loopback port, standing in for a fallback port. */
async function listen(app: express.Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing server address');
  }
  return {
    port: address.port,
    client: request(`http://127.0.0.1:${address.port}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('browser origin gate on public procedures', () => {
  it('rejects cross-site browser origins before any query or mutation runs', async () => {
    const { app, state } = createApp();
    const origin = { origin: 'https://attacker.example' };

    expect((await read(app, origin)).status).toBe(403);
    expect((await write(app, origin)).status).toBe(403);
    expect(state).toEqual({ reads: 0, writes: 0, privileged: 0 });
  });

  it('rejects a preflight-free cross-site form post to an input-less mutation', async () => {
    const { app, state } = createApp();
    // multipart/form-data is a CORS-safelisted type, so browsers send it
    // without a preflight and tRPC routes it to the mutation.
    const formPost = () => request(app).post('/api/trpc/write').field('x', '1');

    expect((await formPost().set('origin', 'https://attacker.example')).status).toBe(403);
    expect(state.writes).toBe(0);
    expect((await formPost()).status).toBe(200);
    expect(state.writes).toBe(1);
  });

  it.each(['null', ''])('rejects the opaque Origin %j', async (origin) => {
    const { app, state } = createApp();

    expect((await write(app, { origin })).status).toBe(403);
    expect(state.writes).toBe(0);
  });

  it('rejects a DNS-rebound Host on a loopback-bound server, even without an Origin', async () => {
    const { app, state } = createApp();
    // A same-origin GET from the rebound page carries no Origin header.
    const response = await read(app, { host: 'attacker.example:3001' });

    expect(response.status).toBe(403);
    expect(state.reads).toBe(0);
  });

  it('rejects a DNS-rebound Host when BACKEND_HOST names a loopback address', async () => {
    const { app, state } = createApp({ backendHost: '127.0.0.1' });

    expect((await write(app, { host: 'attacker.example:3001' })).status).toBe(403);
    expect(state.writes).toBe(0);
  });

  it('skips Host validation when the server is bound beyond loopback', async () => {
    const { app, state } = createApp({ backendHost: '0.0.0.0' });

    expect((await read(app, { host: 'factory.lan:7001' })).status).toBe(200);
    expect(state.reads).toBe(1);
  });

  it('lets DISABLE_CORS_CHECKS admit any Origin and Host', async () => {
    const { app, state } = createApp({ cors: { disableCorsChecks: true } });
    const headers = { origin: 'https://attacker.example', host: 'attacker.example:3001' };

    expect((await write(app, headers)).status).toBe(200);
    expect(state.writes).toBe(1);
  });

  it('still runs the trusted-local checks after the browser gate', async () => {
    const { app, state } = createApp();
    const response = await write(app, { 'x-forwarded-for': '203.0.113.10' }, 'privileged');

    expect(response.status).toBe(403);
    expect(response.body.error.json.message).toContain('trusted local Factory Factory client');
    expect(state.privileged).toBe(0);
  });

  it('rejects a DNS-rebound Host on trusted procedures too', async () => {
    const { app, state } = createApp();

    expect((await write(app, { host: 'attacker.example:3001' }, 'privileged')).status).toBe(403);
    expect(state.privileged).toBe(0);
  });

  it('keeps in-process callers trusted', async () => {
    const testRouter = router({ write: publicProcedure.mutation(() => 'ok') });

    await expect(testRouter.createCaller(unsafeCoerce({ appContext: {} })).write()).resolves.toBe(
      'ok'
    );
  });
});

describe('browser origin gate per launch mode', () => {
  it('desktop app: the window origin is the backend localhost URL', async () => {
    const { app, state } = createApp();
    const headers = { origin: 'http://localhost:3001', host: 'localhost:3001' };

    expect((await write(app, headers)).status).toBe(200);
    expect((await write(app, headers, 'privileged')).status).toBe(200);
    expect(state).toMatchObject({ writes: 1, privileged: 1 });
  });

  it('desktop app on a fallback port: its own origin is allowed without configuration', async () => {
    const { app, state } = createApp();
    const server = await listen(app);
    try {
      const own = { origin: `http://localhost:${server.port}`, host: `localhost:${server.port}` };
      const send = (headers: Headers, path = 'write') =>
        server.client.post(`/api/trpc/${path}`).send({ json: null }).set(headers);

      expect((await send(own)).status).toBe(200);
      expect((await send(own, 'privileged')).status).toBe(200);
      // A loopback page on any other port is still a different origin.
      const otherPort = { ...own, origin: `http://localhost:${server.port + 1}` };
      expect((await send(otherPort)).status).toBe(403);
      expect((await send(otherPort, 'privileged')).status).toBe(403);
      expect(state).toMatchObject({ writes: 1, privileged: 1 });
    } finally {
      await server.close();
    }
  });

  it('ff serve --host 0.0.0.0 and Docker: the own origin is not implied', async () => {
    const { app, state } = createApp({
      backendHost: '0.0.0.0',
      cors: { allowedOrigins: ['http://localhost:7001'] },
    });
    const server = await listen(app);
    try {
      const response = await server.client
        .post('/api/trpc/write')
        .send({ json: null })
        .set({ origin: `http://localhost:${server.port}`, host: `localhost:${server.port}` });

      expect(response.status).toBe(403);
      expect(state.writes).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("ff tailscale: a page on the remote user's own localhost:<backend port> is not implied", async () => {
    const { app, state } = createApp({
      backendHost: '127.0.0.1',
      cors: { allowedOrigins: ['https://mac.tail123.ts.net'], trustProxyHeaders: true },
    });
    const server = await listen(app);
    try {
      // Serve forwards the remote browser's Origin to the backend's own port.
      const response = await server.client
        .post('/api/trpc/write')
        .send({ json: null })
        .set({
          origin: `http://localhost:${server.port}`,
          host: 'mac.tail123.ts.net',
          'x-forwarded-for': '100.100.100.100',
        });

      expect(response.status).toBe(403);
      expect(state.writes).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('pnpm dev: Vite on 3000 proxies with changeOrigin to localhost:3001', async () => {
    const { app, state } = createApp({ backendHost: 'localhost' });
    const headers = { origin: 'http://localhost:3000', host: 'localhost:3001' };

    expect((await write(app, headers)).status).toBe(200);
    expect(state.writes).toBe(1);
  });

  it('pnpm dev:electron: the Vite origin on 5173 is configured by the script', async () => {
    const { app, state } = createApp({ cors: { allowedOrigins: ['http://localhost:5173'] } });
    const headers = { origin: 'http://localhost:5173', host: 'localhost:3001' };

    expect((await write(app, headers)).status).toBe(200);
    expect(state.writes).toBe(1);
  });

  it('ff serve: the CLI allows its own localhost origin', async () => {
    const { app, state } = createApp({
      backendHost: 'localhost',
      cors: { allowedOrigins: ['http://localhost:3005'] },
    });
    // Loopback aliases of the configured origin are accepted, as for WebSockets.
    const headers = { origin: 'http://127.0.0.1:3005', host: '127.0.0.1:3005' };

    expect((await write(app, headers)).status).toBe(200);
    expect(state.writes).toBe(1);
  });

  it('ff serve --host 0.0.0.0 and Docker: configured origins work on any Host', async () => {
    const { app, state } = createApp({
      backendHost: '0.0.0.0',
      cors: { allowedOrigins: ['http://localhost:7001', 'http://192.168.1.20:7001'] },
    });

    expect(
      (await write(app, { origin: 'http://localhost:7001', host: 'localhost:7001' })).status
    ).toBe(200);
    expect(
      (await write(app, { origin: 'http://192.168.1.20:7001', host: '192.168.1.20:7001' })).status
    ).toBe(200);
    // An origin missing from CORS_ALLOWED_ORIGINS is rejected, as WebSockets already are.
    expect(
      (await write(app, { origin: 'http://192.168.1.21:7001', host: '192.168.1.20:7001' })).status
    ).toBe(403);
    expect(state.writes).toBe(2);
  });

  it('ff tailscale: Serve keeps the tailnet Host and Origin', async () => {
    const origin = 'https://mac.tail123.ts.net';
    const { app, state } = createApp({
      backendHost: '127.0.0.1',
      cors: { allowedOrigins: [origin], trustProxyHeaders: true },
    });
    const headers = {
      origin,
      host: 'mac.tail123.ts.net',
      'x-forwarded-for': '100.100.100.100',
    };

    expect((await write(app, headers)).status).toBe(200);
    expect((await write(app, headers, 'privileged')).status).toBe(200);
    expect(state).toMatchObject({ writes: 1, privileged: 1 });
  });

  it('ff proxy: the auth proxy rewrites Host; tunnel browser origins are not allowed', async () => {
    const { app, state } = createApp({ backendHost: '127.0.0.1' });
    const upstream = createServer(app);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('Missing upstream address');
    }
    const authProxy = await proxyInternals.createAuthProxy({
      upstreamPort: address.port,
      password: 'ABC123',
      magicToken: 'test-auth-token',
    });
    try {
      const proxy = request(`http://127.0.0.1:${authProxy.port}`);
      const tunnelHeaders = { host: 'quiet-river.trycloudflare.com' };

      const query = await proxy.get('/api/trpc/read?token=test-auth-token').set(tunnelHeaders);
      expect(query.status).toBe(200);

      const browserMutation = await proxy
        .post('/api/trpc/write?token=test-auth-token')
        .send({ json: null })
        .set({ ...tunnelHeaders, origin: 'https://quiet-river.trycloudflare.com' });
      expect(browserMutation.status).toBe(403);
      expect(state).toMatchObject({ reads: 1, writes: 0 });
    } finally {
      await authProxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('agent MCP servers and CLI clients send no Origin', async () => {
    const { app, state } = createApp();

    expect((await write(app, { host: 'localhost:3001' })).status).toBe(200);
    expect(state.writes).toBe(1);
  });
});
