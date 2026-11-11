import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPrecompressedStatic,
  readPrecompressedDocument,
  sendPrecompressedHtml,
} from './precompressed-static.middleware';

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const servers: Server[] = [];
let root: string;

function rawRequest(
  server: Server,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET'
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
    req.end();
  });
}

async function listen(app: express.Express): Promise<Server> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function writeWithSiblings(path: string, content: string): void {
  writeFileSync(path, content);
  writeFileSync(`${path}.br`, brotliCompressSync(content));
  writeFileSync(`${path}.gz`, gzipSync(content));
}

const script = `export const value = "${'x'.repeat(4000)}";`;
const html = `<!doctype html><html><body>${'<p>hello</p>'.repeat(200)}</body></html>`;

/** Mirrors the production mount in `server.ts`. */
function createApp(): express.Express {
  const app = express();
  app.use(
    '/assets',
    createPrecompressedStatic(join(root, 'assets'), {
      maxAge: '1y',
      immutable: true,
      etag: false,
    })
  );
  app.use(
    createPrecompressedStatic(root, {
      maxAge: '1d',
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    })
  );
  const document = readPrecompressedDocument(join(root, 'index.html'));
  app.get('/{*splat}', (req, res) => {
    sendPrecompressedHtml(req, res, document);
  });
  return app;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-precompressed-static-'));
  mkdirSync(join(root, 'assets'));
  writeWithSiblings(join(root, 'assets/app-abc123.js'), script);
  writeWithSiblings(join(root, 'assets/name with space.css'), `body{color:red}${' '.repeat(2000)}`);
  writeFileSync(join(root, 'assets/logo.png'), Buffer.alloc(2048, 1));
  writeWithSiblings(join(root, 'index.html'), html);
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
  rmSync(root, { recursive: true, force: true });
});

describe('createPrecompressedStatic', () => {
  it('serves the Brotli sibling with the original type and cache headers', async () => {
    const server = await listen(createApp());
    const response = await rawRequest(server, '/assets/app-abc123.js', {
      'accept-encoding': 'gzip, deflate, br, zstd',
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(Number(response.headers['content-length'])).toBe(response.body.length);
    expect(response.body.length).toBeLessThan(script.length / 10);
    expect(brotliDecompressSync(response.body).toString()).toBe(script);
  });

  it('serves gzip to clients without Brotli support', async () => {
    const server = await listen(createApp());
    const response = await rawRequest(server, '/assets/app-abc123.js?v=1', {
      'accept-encoding': 'gzip, deflate',
    });

    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(gunzipSync(response.body).toString()).toBe(script);
  });

  it('serves the original bytes with Vary when the client accepts no coding', async () => {
    const server = await listen(createApp());
    const response = await rawRequest(server, '/assets/app-abc123.js');

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(response.body.toString()).toBe(script);
  });

  it('decodes request paths before looking up siblings', async () => {
    const server = await listen(createApp());
    const response = await rawRequest(server, '/assets/name%20with%20space.css', {
      'accept-encoding': 'br',
    });

    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('leaves files without siblings, such as images, unchanged', async () => {
    const server = await listen(createApp());
    const response = await rawRequest(server, '/assets/logo.png', { 'accept-encoding': 'br' });

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.body.length).toBe(2048);
  });

  it('answers HEAD with the encoded headers and no body', async () => {
    const server = await listen(createApp());
    const response = await rawRequest(
      server,
      '/assets/app-abc123.js',
      { 'accept-encoding': 'br' },
      'HEAD'
    );

    expect(response.headers['content-encoding']).toBe('br');
    expect(response.body.length).toBe(0);
  });

  it('passes the original file path to setHeaders for an encoded variant', async () => {
    const server = await listen(createApp());
    const response = await rawRequest(server, '/index.html', { 'accept-encoding': 'br' });

    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('falls back to the original file when a sibling disappears after startup', async () => {
    const server = await listen(createApp());
    rmSync(join(root, 'assets/app-abc123.js.br'));
    const response = await rawRequest(server, '/assets/app-abc123.js', {
      'accept-encoding': 'br',
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.body.toString()).toBe(script);
  });

  it('does not expose siblings for paths without a source file', async () => {
    writeFileSync(join(root, 'assets/orphan.js.br'), brotliCompressSync('orphan'));
    const server = await listen(createApp());
    const response = await rawRequest(server, '/assets/orphan.js', { 'accept-encoding': 'br' });

    // Without its source file the request reaches the SPA fallback, as before.
    expect(response.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(response.body).toString()).toBe(html);
  });

  it('tolerates a missing root like express.static', async () => {
    const app = express();
    app.use('/assets', createPrecompressedStatic(join(root, 'missing'), {}));
    const server = await listen(app);
    const response = await rawRequest(server, '/assets/app.js', { 'accept-encoding': 'br' });

    expect(response.status).toBe(404);
  });
});

describe('sendPrecompressedHtml', () => {
  it('sends the SPA document precompressed when accepted', async () => {
    const server = await listen(createApp());
    const response = await rawRequest(server, '/projects/abc', { 'accept-encoding': 'br' });

    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(brotliDecompressSync(response.body).toString()).toBe(html);
  });

  it('sends the plain document otherwise', async () => {
    const server = await listen(createApp());
    const response = await rawRequest(server, '/projects/abc');

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body.toString()).toBe(html);
  });

  it('sends a document without siblings unchanged', async () => {
    rmSync(join(root, 'index.html.br'));
    rmSync(join(root, 'index.html.gz'));
    const server = await listen(createApp());
    const response = await rawRequest(server, '/projects/abc', { 'accept-encoding': 'br' });

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
    expect(response.body.toString()).toBe(html);
  });
});
