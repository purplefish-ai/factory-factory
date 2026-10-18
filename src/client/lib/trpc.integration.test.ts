import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { initTRPC, TRPCError } from '@trpc/server';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express, { type Response as ExpressResponse } from 'express';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  authenticateRequest,
  createSessionValue,
  proxyAuthenticatedHttpRequest,
} from '@/shared/proxy-utils';
import { createTrpcClient } from './trpc';

const nativeFetch = globalThis.fetch;
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP test server');
  }
  return address.port;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function createFixture(proxied: boolean) {
  const cookieSecret = randomBytes(32);
  const session = createSessionValue(cookieSecret);
  const sessionCookie = `ff_proxy_session=${session.id}.${session.signature}`;
  const slow = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const value = {
    files: [],
    hasUncommitted: false,
    observedAt: new Date('2026-10-17T12:00:00Z'),
    optional: undefined,
  };
  const requests: { method: string; accept: string | undefined; cookie: string | undefined }[] = [];
  const responses: { contentType: string | null; cookies: string[] }[] = [];
  const fetchOptions: (RequestInit | undefined)[] = [];
  const t = initTRPC.context<{ res: ExpressResponse }>().create({ transformer: superjson });
  const fixtureRouter = t.router({
    workspace: t.router({
      getGitStatus: t.procedure
        .input(z.object({ workspaceId: z.string() }))
        .query(async ({ input }) => {
          if (input.workspaceId === 'slow') {
            started.resolve();
            await slow.promise;
          }
          if (input.workspaceId === 'error') {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Read denied' });
          }
          return value;
        }),
    }),
    admin: t.router({
      resetApiUsageStats: t.procedure.mutation(({ ctx }) => {
        ctx.res.cookie('fixture', 'updated', { httpOnly: true });
        return { success: true, message: 'API usage statistics reset' };
      }),
    }),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    requests.push({
      method: req.method,
      accept: req.headers['trpc-accept']?.toString(),
      cookie: req.headers.cookie,
    });
    next();
  });
  app.use(
    '/api/trpc',
    createExpressMiddleware({ router: fixtureRouter, createContext: ({ res }) => ({ res }) })
  );
  const upstreamPort = await listen(createServer(app));
  const port = proxied
    ? await listen(
        createServer((req, res) => {
          const auth = authenticateRequest({
            req,
            cookieSecret,
            authToken: 'fixture-token',
            sessionCookieName: 'ff_proxy_session',
          });
          if (!auth.authenticated) {
            res.writeHead(401).end();
            return;
          }
          proxyAuthenticatedHttpRequest({
            req,
            res,
            upstreamPort,
            path: auth.sanitizedPath,
            sessionCookieName: 'ff_proxy_session',
            localHost: '127.0.0.1',
          });
        })
      )
    : upstreamPort;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchOptions.push(init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await nativeFetch(new URL(url, `http://127.0.0.1:${port}`), {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        cookie: `fixture=incoming; ${sessionCookie}`,
      },
    });
    responses.push({
      contentType: response.headers.get('content-type'),
      cookies: response.headers.getSetCookie(),
    });
    return response;
  });
  return {
    client: createTrpcClient(),
    slow,
    started,
    value,
    requests,
    responses,
    fetchOptions,
    baseUrl: `http://127.0.0.1:${port}`,
    invalidSessionCookie: `ff_proxy_session=${session.id}.${'0'.repeat(64)}`,
  };
}

describe.each([false, true])('tRPC transport (authenticated proxy: %s)', (proxied) => {
  it('delivers a completed query before its slow batch sibling with SuperJSON intact', async () => {
    const fixture = await createFixture(proxied);
    const pending = fixture.client.workspace.getGitStatus.query({ workspaceId: 'slow' });
    let received: unknown;
    const fast = fixture.client.workspace.getGitStatus
      .query({ workspaceId: 'fast' })
      .then((result) => {
        received = result;
        return result;
      });
    try {
      await fixture.started.promise;
      await vi.waitFor(() => expect(received).toStrictEqual(fixture.value), { timeout: 1000 });
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.accept).toBe('application/jsonl');
      expect(fixture.responses[0]?.contentType).toContain('application/json');
      expect(fixture.fetchOptions[0]?.credentials).toBeUndefined();
      expect(fixture.requests[0]?.cookie).toContain('fixture=incoming');
      if (proxied) {
        expect(fixture.requests[0]?.cookie).not.toContain('ff_proxy_session');
      }
    } finally {
      fixture.slow.resolve();
      await Promise.allSettled([pending, fast]);
    }
    await expect(pending).resolves.toEqual(fixture.value);
  });

  it('preserves independent errors without discarding a successful query', async () => {
    const fixture = await createFixture(proxied);
    const results = await Promise.allSettled([
      fixture.client.workspace.getGitStatus.query({ workspaceId: 'error' }),
      fixture.client.workspace.getGitStatus.query({ workspaceId: 'fast' }),
    ]);
    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: { message: 'Read denied', data: { code: 'FORBIDDEN' } },
    });
    expect(results[1]).toStrictEqual({ status: 'fulfilled', value: fixture.value });
    expect(fixture.requests).toHaveLength(1);
  });

  if (proxied) {
    it.each(['unsigned', 'invalid signature'])(
      'rejects a proxy session with %s before forwarding',
      async (kind) => {
        const fixture = await createFixture(true);
        const response = await nativeFetch(
          `${fixture.baseUrl}/api/trpc/admin.resetApiUsageStats?batch=1`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie:
                kind === 'unsigned' ? 'ff_proxy_session=unsigned' : fixture.invalidSessionCookie,
            },
            body: JSON.stringify({ 0: { json: null } }),
          }
        );
        expect(response.status).toBe(401);
        expect(fixture.requests).toHaveLength(0);
      }
    );
  }

  it('keeps mutations on ordinary HTTP batching and preserves response cookies', async () => {
    const fixture = await createFixture(proxied);
    await expect(fixture.client.admin.resetApiUsageStats.mutate()).resolves.toEqual({
      success: true,
      message: 'API usage statistics reset',
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.method).toBe('POST');
    expect(fixture.requests[0]?.accept).toBeUndefined();
    expect(fixture.responses[0]?.contentType).toContain('application/json');
    expect(fixture.responses[0]?.contentType).not.toContain('jsonl');
    expect(fixture.responses[0]?.cookies).toEqual([expect.stringContaining('fixture=updated')]);
  });
});
