import { createServer, request, type Server } from 'node:http';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import superjson from 'superjson';
import supertest from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { createRecoveryJsonBodyMiddleware } from '@/backend/middleware/recovery-json-body.middleware';
import { adminRouter } from '@/backend/trpc/admin.trpc';
import { router } from '@/backend/trpc/trpc';
import { createTrpcClient } from '@/client/lib/trpc';
import {
  assertRecoveryWireBudget,
  MAX_RECOVERY_HTTP_BODY_BYTES,
  MAX_RECOVERY_PACKAGE_BYTES,
} from '@/shared/recovery-wire-budget';
import { exportDataSchema, type ExportData } from '@/shared/schemas/export-data.schema';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

const nativeFetch = globalThis.fetch;
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (!server.listening) {
      continue;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

async function fixture(importGate?: () => Promise<void>) {
  const imports: ExportData[] = [];
  const resetUsageStats = vi.fn();
  const appContext = unsafeCoerce<AppContext>({
    services: {
      rateLimiter: { resetUsageStats },
      dataBackupService: {
        importData: async (input: ExportData) => {
          imports.push(input);
          await importGate?.();
          return {
            projects: { imported: 0, skipped: 0 },
            workspaces: { imported: 0, skipped: 0 },
            agentSessions: { imported: 0, skipped: 0 },
            terminalSessions: { imported: 0, skipped: 0 },
            userSettings: { imported: true, skipped: false },
          };
        },
      },
    },
  });
  const app = express();
  app.use(createRecoveryJsonBodyMiddleware());
  app.post('/normal', (_req, res) => res.json({ ok: true }));
  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: router({ admin: adminRouter }),
      createContext: () => ({ appContext }),
    })
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP fixture');
  }
  const url = `http://127.0.0.1:${address.port}`;
  const sent: { path: string; bytes: number; body: unknown }[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (typeof init?.body === 'string') {
      sent.push({ path, bytes: Buffer.byteLength(init.body), body: JSON.parse(init.body) });
    }
    return nativeFetch(new URL(path, url), init);
  });
  return { app, imports, sent, resetUsageStats, client: createTrpcClient(), port: address.port };
}

function backup(text: string): ExportData {
  return exportDataSchema.parse({
    meta: { exportedAt: '2026-01-01T00:00:00.000Z', version: 'test', schemaVersion: 4 },
    data: {
      projects: [],
      workspaces: [],
      agentSessions: [],
      terminalSessions: [],
      userSettings: {
        preferredIde: 'custom',
        customIdeCommand: text,
        playSoundOnComplete: false,
        notificationSoundPath: null,
        ratchetEnabled: false,
        defaultSessionProvider: 'CLAUDE',
      },
    },
  });
}

describe('recovery HTTP JSON budget', () => {
  it('imports more than10MiB through the production client and real admin.importData procedure', async () => {
    const f = await fixture();
    // Quotes, backslashes, newlines and multibyte Unicode expand differently on the wire.
    const text = '"\\\né'.repeat(2 * 1024 * 1024);
    const input = backup(text);
    assertRecoveryWireBudget(input);
    expect(Buffer.byteLength(text)).toBeLessThan(11 * 1024 * 1024);
    await expect(f.client.admin.importData.mutate(input)).resolves.toMatchObject({ success: true });
    expect(f.sent[0]?.path).toBe('/api/trpc/admin.importData');
    expect(f.sent[0]?.bytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(f.sent[0]?.body).toEqual(superjson.serialize(input));
    expect(f.imports[0]?.data.userSettings?.customIdeCommand).toBe(text);
  });

  it('rejects an oversized HTTP body before requiring a giant allocation', async () => {
    const f = await fixture();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: f.port,
          path: '/api/trpc/admin.importData?batch=1',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': MAX_RECOVERY_HTTP_BODY_BYTES + 1,
            connection: 'close',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        }
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(413);
    expect(f.imports).toHaveLength(0);
  });

  it('rejects an actually oversized chunked import without trusting Content-Length', async () => {
    const f = await fixture();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: f.port,
          path: '/api/trpc/admin.importData?batch=1',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
            connection: 'close',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        }
      );
      req.on('error', reject);
      req.write('{"0":{"json":{"text":"');
      const chunk = Buffer.alloc(1024 * 1024, 'x');
      for (let index = 0; index < 66; index++) {
        req.write(chunk);
      }
      req.end('"}}}');
    });
    expect(status).toBe(413);
    expect(f.imports).toHaveLength(0);
  });

  it('preserves the normal10MiB API limit and does not widen methods or route aliases', async () => {
    const f = await fixture();
    const large = { text: 'x'.repeat(10 * 1024 * 1024 + 1) };
    await supertest(f.app).post('/normal').send({ text: 'small' }).expect(200);
    for (const path of [
      '/normal',
      '/api/trpc/admin.importData/',
      '/api/trpc/admin.importDataExtra',
    ]) {
      await supertest(f.app).post(path).send(large).expect(413);
    }
    await supertest(f.app).get('/api/trpc/admin.importData').send(large).expect(413);
    expect(f.imports).toHaveLength(0);
  });

  it('isolates a valid import from an ordinary mutation started in the same batch window', async () => {
    const f = await fixture();
    const input = backup('small');
    await expect(
      Promise.all([
        f.client.admin.importData.mutate(input),
        f.client.admin.resetApiUsageStats.mutate(),
        f.client.admin.resetApiUsageStats.mutate(),
      ])
    ).resolves.toEqual([
      expect.objectContaining({ success: true }),
      { success: true, message: 'API usage statistics reset' },
      { success: true, message: 'API usage statistics reset' },
    ]);
    expect(f.imports).toEqual([input]);
    expect(f.resetUsageStats).toHaveBeenCalledTimes(2);
    expect(f.sent.map((row) => row.path).sort()).toEqual([
      '/api/trpc/admin.importData',
      '/api/trpc/admin.resetApiUsageStats,admin.resetApiUsageStats?batch=1',
    ]);
  });

  it('cancels an isolated import without cancelling a same-window ordinary mutation', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(async () => {
      started.resolve();
      await release.promise;
    });
    const cancellation = new AbortController();
    const pending = f.client.admin.importData.mutate(backup('cancelled request'), {
      signal: cancellation.signal,
    });
    const cancelled = expect(pending).rejects.toMatchObject({
      message: expect.stringMatching(/abort/i),
    });
    const ordinary = f.client.admin.resetApiUsageStats.mutate();
    try {
      await started.promise;
      cancellation.abort();
      await cancelled;
      await expect(ordinary).resolves.toEqual({
        success: true,
        message: 'API usage statistics reset',
      });
      expect(f.resetUsageStats).toHaveBeenCalledOnce();
      expect(f.sent.map((row) => row.path).sort()).toEqual([
        '/api/trpc/admin.importData',
        '/api/trpc/admin.resetApiUsageStats?batch=1',
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending, ordinary]);
    }
  });

  it('rejects malicious combined import routes and unexpected batch indices with readable errors', async () => {
    const f = await fixture();
    const input = superjson.serialize(backup('small'));
    const combined = await supertest(f.app)
      .post('/api/trpc/admin.importData,admin.resetApiUsageStats?batch=1')
      .send({ 0: input, 1: superjson.serialize(undefined) })
      .expect(400);
    expect(combined.body.error.json.message).toBe(
      'Recovery imports must be sent as a single request.'
    );
    expect(f.imports).toHaveLength(0);
    expect(f.resetUsageStats).not.toHaveBeenCalled();
    const response = await supertest(f.app)
      .post('/api/trpc/admin.importData?batch=1')
      .send({ 0: input, 1: input })
      .expect(400);
    expect(response.body.error.json.message).toBe('Invalid recovery import request envelope.');
  });

  it('supports the ordinary unbatched SuperJSON envelope', async () => {
    const f = await fixture();
    await supertest(f.app)
      .post('/api/trpc/admin.importData')
      .send(superjson.serialize(backup('small')))
      .expect(200);
    expect(f.imports).toHaveLength(1);
  });

  it('enforces a64MiB serialized UTF8 package budget including escaped string overhead', () => {
    const text = '"'.repeat(MAX_RECOVERY_PACKAGE_BYTES / 2);
    expect(Buffer.byteLength(text)).toBe(MAX_RECOVERY_PACKAGE_BYTES / 2);
    expect(() => assertRecoveryWireBudget({ text })).toThrow('64 MiB');
    expect(() => assertRecoveryWireBudget({ text: '😀\\\n"' })).not.toThrow();
  });
});
