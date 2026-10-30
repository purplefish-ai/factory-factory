import { createServer } from 'node:http';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { proxyInternals } from '@/cli/proxy';
import { FORWARDED_CLIENT_ADDRESS_HEADERS } from '@/shared/proxy-utils';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createContext, router, trustedLocalProcedure } from './trpc';

function createApp(options: { trustProxyHeaders?: boolean; disableCorsChecks?: boolean } = {}) {
  const app = express();
  const state = { executions: 0 };
  const appContext = unsafeCoerce<AppContext>({
    services: {
      configService: {
        getCorsConfig: () => ({
          allowedOrigins: ['http://localhost:3000'],
          trustedLocalCidrs: [],
          trustProxyHeaders: false,
          disableCorsChecks: false,
          ...options,
        }),
      },
    },
  });
  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: router({
        execute: trustedLocalProcedure.mutation(() => ++state.executions),
      }),
      createContext: createContext(appContext),
    })
  );
  return { app, state };
}

describe('privileged HTTP request trust', () => {
  it.each(FORWARDED_CLIENT_ADDRESS_HEADERS)(
    'rejects tunneled requests carrying %s without an Origin',
    async (header) => {
      const { app, state } = createApp();
      const response = await request(app)
        .post('/api/trpc/execute')
        .send({ json: null })
        .set(header, '203.0.113.10');

      expect(response.status).toBe(403);
      expect(state.executions).toBe(0);
    }
  );

  it.each([false, true])(
    'rejects a forwarded request with an allowed Origin (disableCorsChecks=%s)',
    async (disableCorsChecks) => {
      const { app, state } = createApp({ disableCorsChecks });
      const response = await request(app)
        .post('/api/trpc/execute')
        .send({ json: null })
        .set('origin', 'http://localhost:3000')
        .set('cf-connecting-ip', '203.0.113.10');

      expect(response.status).toBe(403);
      expect(state.executions).toBe(0);
    }
  );

  it('allows direct local requests without an Origin', async () => {
    const { app, state } = createApp();
    const response = await request(app).post('/api/trpc/execute').send({ json: null });

    expect(response.status).toBe(200);
    expect(state.executions).toBe(1);
  });

  it('preserves the explicit trusted reverse-proxy opt-in', async () => {
    const { app, state } = createApp({ trustProxyHeaders: true });
    const response = await request(app)
      .post('/api/trpc/execute')
      .send({ json: null })
      .set('x-forwarded-for', '203.0.113.10');

    expect(response.status).toBe(200);
    expect(state.executions).toBe(1);
  });

  it('requires authentication before a private proxy can forward privileged requests', async () => {
    const { app, state } = createApp();
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
      const denied = await proxy
        .post('/api/trpc/execute')
        .send({ json: null })
        .set('cf-connecting-ip', '203.0.113.10');
      expect(denied.type).toBe('text/html');
      expect(denied.text).toContain('password');
      expect(state.executions).toBe(0);

      const allowed = await proxy
        .post('/api/trpc/execute?token=test-auth-token')
        .send({ json: null })
        .set('cf-connecting-ip', '203.0.113.10')
        .set('x-forwarded-for', '203.0.113.10');
      expect(allowed.status).toBe(200);
      expect(state.executions).toBe(1);
    } finally {
      await authProxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
