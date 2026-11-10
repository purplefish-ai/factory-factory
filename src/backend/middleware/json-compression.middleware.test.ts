import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createTRPCClient, httpBatchLink, httpBatchStreamLink } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import superjson from 'superjson';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJsonCompressionMiddleware,
  JSON_COMPRESSION_THRESHOLD_BYTES,
} from './json-compression.middleware';

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

async function listen(app: express.Express): Promise<Server> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function baseUrl(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rawRequest(
  server: Server,
  path: string,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const largePayload = { items: Array.from({ length: 200 }, (_, index) => ({ index, name: 'x' })) };

function createExpressApp(): express.Express {
  const app = express();
  app.use(createJsonCompressionMiddleware());
  app.get('/large', (_req, res) => {
    res.json(largePayload);
  });
  app.get('/small', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/text', (_req, res) => {
    res.type('text').send('x'.repeat(4000));
  });
  app.get('/encoded', (_req, res) => {
    res.set('Content-Encoding', 'identity').json(largePayload);
  });
  app.get('/chunks', (_req, res) => {
    res.type('json');
    res.write('{"items":[');
    res.write(Buffer.from(largePayload.items.map((item) => JSON.stringify(item)).join(',')));
    res.end(']}');
  });
  app.get('/no-content', (_req, res) => {
    res.status(204).end();
  });
  return app;
}

describe('createJsonCompressionMiddleware', () => {
  it('compresses JSON above the threshold with Brotli when accepted', async () => {
    const server = await listen(createExpressApp());
    const response = await rawRequest(server, '/large', {
      'accept-encoding': 'gzip, deflate, br, zstd',
    });

    expect(JSON.stringify(largePayload).length).toBeGreaterThan(JSON_COMPRESSION_THRESHOLD_BYTES);
    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(Number(response.headers['content-length'])).toBe(response.body.length);
    expect(JSON.parse(brotliDecompressSync(response.body).toString())).toEqual(largePayload);
  });

  it('falls back to gzip', async () => {
    const server = await listen(createExpressApp());
    const response = await rawRequest(server, '/large', { 'accept-encoding': 'gzip' });

    expect(response.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(response.body).toString())).toEqual(largePayload);
  });

  it('compresses a body written in several chunks', async () => {
    const server = await listen(createExpressApp());
    const response = await rawRequest(server, '/chunks', { 'accept-encoding': 'gzip' });

    expect(response.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(response.body).toString())).toEqual(largePayload);
  });

  it('sends identity with Vary when the client accepts no coding', async () => {
    const server = await listen(createExpressApp());
    const response = await rawRequest(server, '/large');

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(JSON.parse(response.body.toString())).toEqual(largePayload);
  });

  it('leaves small JSON uncompressed', async () => {
    const server = await listen(createExpressApp());
    const response = await rawRequest(server, '/small', { 'accept-encoding': 'br' });

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(response.body.toString())).toEqual({ ok: true });
  });

  it.each(['/text', '/encoded'])('leaves %s untouched', async (path) => {
    const server = await listen(createExpressApp());
    const response = await rawRequest(server, path, { 'accept-encoding': 'br' });

    expect(response.headers['content-encoding']).not.toBe('br');
    expect(response.headers.vary).toBeUndefined();
  });

  it('ends bodyless responses normally', async () => {
    const server = await listen(createExpressApp());
    const response = await rawRequest(server, '/no-content', { 'accept-encoding': 'br' });

    expect(response.status).toBe(204);
    expect(response.headers['content-encoding']).toBeUndefined();
  });
});

describe('createJsonCompressionMiddleware with tRPC', () => {
  function createTrpcApp() {
    const t = initTRPC.create({ transformer: superjson });
    let releaseSlow: (value: string) => void = () => undefined;
    const slow = new Promise<string>((resolve) => {
      releaseSlow = resolve;
    });
    const appRouter = t.router({
      large: t.procedure.query(() => largePayload),
      fast: t.procedure.query(() => 'fast'),
      slow: t.procedure.query(() => slow),
      save: t.procedure.mutation(() => largePayload),
    });
    const app = express();
    app.use(
      '/api/trpc',
      createJsonCompressionMiddleware(),
      createExpressMiddleware({ router: appRouter })
    );
    return { app, appRouter, releaseSlow };
  }

  it('compresses a non-streaming batch response', async () => {
    const { app } = createTrpcApp();
    const server = await listen(app);
    const response = await rawRequest(server, '/api/trpc/large?batch=1&input=%7B%7D', {
      'accept-encoding': 'br',
    });

    expect(response.headers['content-encoding']).toBe('br');
    const [result] = JSON.parse(brotliDecompressSync(response.body).toString());
    expect(result.result.data.json).toEqual(largePayload);
  });

  it('leaves streamed batches unencoded', async () => {
    const { app, releaseSlow } = createTrpcApp();
    const server = await listen(app);
    releaseSlow('slow');
    const response = await rawRequest(server, '/api/trpc/large?batch=1&input=%7B%7D', {
      'accept-encoding': 'br',
      'trpc-accept': 'application/jsonl',
    });

    expect(response.headers['transfer-encoding']).toBe('chunked');
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('round-trips through the client links, streaming early results before late ones', async () => {
    const { app, appRouter, releaseSlow } = createTrpcApp();
    const server = await listen(app);
    const url = `${baseUrl(server)}/api/trpc`;
    const streamClient = createTRPCClient<typeof appRouter>({
      links: [httpBatchStreamLink({ url, transformer: superjson })],
    });
    const batchClient = createTRPCClient<typeof appRouter>({
      links: [httpBatchLink({ url, transformer: superjson })],
    });

    // Both queries share one streamed batch; buffering would hold `fast` until `slow` resolves.
    const slowResult = streamClient.slow.query();
    await expect(streamClient.fast.query()).resolves.toBe('fast');
    releaseSlow('slow');
    await expect(slowResult).resolves.toBe('slow');
    await expect(streamClient.large.query()).resolves.toEqual(largePayload);
    await expect(batchClient.save.mutate()).resolves.toEqual(largePayload);
  });
});
