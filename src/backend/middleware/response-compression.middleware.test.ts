import { createServer, type IncomingMessage, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, createBrotliDecompress, createGunzip, gunzipSync } from 'node:zlib';
import { createTRPCClient, httpBatchStreamLink } from '@trpc/client';
import { initTRPC, TRPCError } from '@trpc/server';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  COMPRESSION_THRESHOLD_BYTES,
  createResponseCompression,
} from './response-compression.middleware';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** About 20 KB of repetitive JSON, like a workspace list. */
const largeList = Array.from({ length: 200 }, (_, index) => ({
  id: `workspace-${index}`,
  name: `Workspace number ${index}`,
  status: 'READY',
}));

function createHarness() {
  const t = initTRPC.create();
  const slowGate = { current: deferred() };
  const slowSignals: AbortSignal[] = [];
  const router = t.router({
    large: t.procedure.query(() => largeList),
    small: t.procedure.query(() => ({ ok: true })),
    echo: t.procedure.input(z.object({ size: z.number() })).query(({ input }) => ({
      text: 'x'.repeat(input.size),
    })),
    fast: t.procedure.query(() => 'fast-marker'),
    slow: t.procedure.query(async ({ signal }) => {
      if (signal) {
        slowSignals.push(signal);
      }
      await slowGate.current.promise;
      return 'slow-marker';
    }),
    missing: t.procedure.query(() => {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No such thing' });
    }),
    rename: t.procedure.input(z.object({ name: z.string() })).mutation(({ input }) => ({
      names: Array.from({ length: 200 }, (_, index) => `${input.name}-${index}`),
    })),
  });
  const app = express();
  // Mirrors the production mount in `server.ts`.
  app.use('/api/trpc', createResponseCompression(), createExpressMiddleware({ router }));
  app.get('/plain', createResponseCompression(), (_req, res) => {
    res.type('text/plain').send('y'.repeat(5000));
  });
  return { app, router, slowGate, slowSignals };
}

const servers: Server[] = [];

async function listen(app: express.Express): Promise<Server> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

function baseUrl(server: Server): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

interface RawResponse {
  status: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

function rawRequest(
  server: Server,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string
): Promise<RawResponse> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

function decode(response: RawResponse): string {
  switch (response.headers['content-encoding']) {
    case 'br':
      return brotliDecompressSync(response.body).toString('utf8');
    case 'gzip':
      return gunzipSync(response.body).toString('utf8');
    case undefined:
      return response.body.toString('utf8');
    default:
      throw new Error(`Unexpected encoding ${response.headers['content-encoding']}`);
  }
}

function varyValues(response: RawResponse): string[] {
  return String(response.headers.vary ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase());
}

/** Starts a streamed batch request and decodes the body as it arrives. */
function startStream(server: Server, path: string, acceptEncoding: string) {
  const { port } = server.address() as AddressInfo;
  let decoded = '';
  let ended = false;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: { 'accept-encoding': acceptEncoding, 'trpc-accept': 'application/jsonl' },
      },
      (res) => {
        const encoding = res.headers['content-encoding'];
        const decoder =
          encoding === 'br'
            ? res.pipe(createBrotliDecompress())
            : encoding === 'gzip'
              ? res.pipe(createGunzip())
              : res;
        decoder.on('data', (chunk: Buffer) => {
          decoded += chunk.toString('utf8');
        });
        decoder.on('end', () => {
          ended = true;
        });
        resolve(res);
      }
    );
    req.on('error', reject);
    req.end();
  });
  return {
    response,
    decoded: () => decoded,
    ended: () => ended,
  };
}

const LARGE_PATH = '/api/trpc/large';

describe('createResponseCompression', () => {
  it('compresses a JSON response with Brotli when the client accepts it', async () => {
    const server = await listen(createHarness().app);
    const identity = await rawRequest(server, LARGE_PATH);

    const response = await rawRequest(server, LARGE_PATH, {
      'accept-encoding': 'gzip, deflate, br',
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers['content-length']).toBeUndefined();
    expect(varyValues(response)).toEqual(
      expect.arrayContaining(['trpc-accept', 'accept', 'accept-encoding'])
    );
    expect(decode(response)).toBe(identity.body.toString('utf8'));
    expect(response.body.length).toBeLessThan(identity.body.length / 4);
  });

  it('falls back to gzip for clients without Brotli, such as Node fetch', async () => {
    const server = await listen(createHarness().app);

    const response = await rawRequest(server, LARGE_PATH, { 'accept-encoding': 'gzip, deflate' });

    expect(response.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(decode(response))).toEqual({ result: { data: largeList } });
  });

  it('sends identity, with Vary, to a client that accepts no supported coding', async () => {
    const server = await listen(createHarness().app);

    const response = await rawRequest(server, LARGE_PATH);

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(varyValues(response)).toContain('accept-encoding');
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({ result: { data: largeList } });
  });

  it('sends a complete body under the threshold uncompressed, with its length', async () => {
    const server = await listen(createHarness().app);
    const size = COMPRESSION_THRESHOLD_BYTES - 100;

    const response = await rawRequest(server, `/api/trpc/echo?input=${JSON.stringify({ size })}`, {
      'accept-encoding': 'br, gzip',
    });

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['content-length']).toBe(String(response.body.length));
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      result: { data: { text: 'x'.repeat(size) } },
    });
  });

  it('compresses a complete body once it reaches the threshold', async () => {
    const server = await listen(createHarness().app);
    const size = COMPRESSION_THRESHOLD_BYTES;

    const response = await rawRequest(server, `/api/trpc/echo?input=${JSON.stringify({ size })}`, {
      'accept-encoding': 'gzip',
    });

    expect(response.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(decode(response))).toEqual({ result: { data: { text: 'x'.repeat(size) } } });
  });

  it('compresses a mutation response, as httpBatchLink sends it', async () => {
    const server = await listen(createHarness().app);

    const response = await rawRequest(
      server,
      '/api/trpc/rename?batch=1',
      { 'accept-encoding': 'br', 'content-type': 'application/json' },
      'POST',
      JSON.stringify({ 0: { name: 'workspace' } })
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('br');
    expect(JSON.parse(decode(response))).toEqual([
      {
        result: {
          data: { names: Array.from({ length: 200 }, (_, index) => `workspace-${index}`) },
        },
      },
    ]);
  });

  it.each(['br', 'gzip'])(
    'delivers each streamed %s line before a later procedure resolves',
    async (acceptEncoding) => {
      const harness = createHarness();
      const server = await listen(harness.app);

      const stream = startStream(server, '/api/trpc/fast,slow?batch=1', acceptEncoding);
      const res = await stream.response;

      expect(res.headers['content-encoding']).toBe(acceptEncoding);
      expect(varyValues({ status: 200, headers: res.headers, body: Buffer.alloc(0) })).toContain(
        'accept-encoding'
      );
      await vi.waitFor(() => expect(stream.decoded()).toContain('fast-marker'));
      expect(stream.decoded()).not.toContain('slow-marker');
      expect(stream.ended()).toBe(false);

      harness.slowGate.current.resolve();

      await vi.waitFor(() => expect(stream.ended()).toBe(true));
      expect(stream.decoded()).toContain('slow-marker');
    }
  );

  it('streams through the tRPC client link with Node fetch', async () => {
    const harness = createHarness();
    harness.slowGate.current.resolve();
    const server = await listen(harness.app);
    const client = createTRPCClient<typeof harness.router>({
      links: [httpBatchStreamLink({ url: `${baseUrl(server)}/api/trpc` })],
    });

    const [large, slow] = await Promise.all([client.large.query(), client.slow.query()]);

    expect(large).toEqual(largeList);
    expect(slow).toBe('slow-marker');
  });

  it('keeps the status and body of an error response', async () => {
    const server = await listen(createHarness().app);

    const response = await rawRequest(server, '/api/trpc/missing', { 'accept-encoding': 'br' });

    expect(response.status).toBe(404);
    expect(JSON.parse(decode(response))).toMatchObject({
      error: { message: 'No such thing', data: { code: 'NOT_FOUND', httpStatus: 404 } },
    });
  });

  it('leaves a HEAD response alone', async () => {
    const server = await listen(createHarness().app);

    const response = await rawRequest(server, LARGE_PATH, { 'accept-encoding': 'br' }, 'HEAD');

    expect(response.status).toBe(204);
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('leaves non-JSON responses alone', async () => {
    const server = await listen(createHarness().app);

    const response = await rawRequest(server, '/plain', { 'accept-encoding': 'br' });

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body.toString('utf8')).toBe('y'.repeat(5000));
  });

  it('aborts the stream when the client disconnects and keeps serving', async () => {
    const harness = createHarness();
    const server = await listen(harness.app);

    const stream = startStream(server, '/api/trpc/fast,slow?batch=1', 'br');
    const res = await stream.response;
    await vi.waitFor(() => expect(stream.decoded()).toContain('fast-marker'));
    res.destroy();

    await vi.waitFor(() => expect(harness.slowSignals[0]?.aborted).toBe(true));
    harness.slowGate.current.resolve();

    const next = await rawRequest(server, LARGE_PATH, { 'accept-encoding': 'br' });
    expect(next.headers['content-encoding']).toBe('br');
    expect(JSON.parse(decode(next))).toEqual({ result: { data: largeList } });
  });
});
