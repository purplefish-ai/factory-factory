import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { ChatImageStore } from '@/backend/lib/chat-image-store';
import type { CorsConfig } from '@/backend/services/config.service';
import { CHAT_IMAGE_ROUTE } from '@/shared/chat-image-ref';
import { noisePng } from '@/test-utils/image-fixtures';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createChatImageRouter } from './chat-image.router';

const png = noisePng(2, 2);
const ID = 'a'.repeat(64);
const ALLOWED_ORIGIN = 'http://localhost:3000';

function setup(options?: { cors?: Partial<CorsConfig>; backendHost?: string }) {
  const store = new ChatImageStore();
  store.put(ID, { mediaType: 'image/png', data: png.toString('base64'), size: png.length });
  const app = express();
  app.use(
    CHAT_IMAGE_ROUTE,
    createChatImageRouter(
      unsafeCoerce<AppContext>({
        services: {
          chatImageStore: store,
          configService: {
            getCorsConfig: (): CorsConfig => ({
              allowedOrigins: [ALLOWED_ORIGIN],
              ...options?.cors,
            }),
            getBackendHost: () => options?.backendHost,
          },
        },
      })
    )
  );
  return { app, store };
}

describe('chat image endpoint', () => {
  let app: express.Express;

  beforeEach(() => {
    ({ app } = setup());
  });

  it('serves the bytes as their raster type, cached for good and never sniffed', async () => {
    const response = await request(app).get(`${CHAT_IMAGE_ROUTE}/${ID}`).buffer(true);

    expect(response.status).toBe(200);
    expect(Buffer.from(response.body).equals(png)).toBe(true);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['content-length']).toBe(String(png.length));
    expect(response.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(response.headers.etag).toBe(`"${ID}"`);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('answers a revalidation with 304 and a HEAD without a body', async () => {
    const revalidated = await request(app)
      .get(`${CHAT_IMAGE_ROUTE}/${ID}`)
      .set('If-None-Match', `"${ID}"`);
    expect(revalidated.status).toBe(304);

    const head = await request(app).head(`${CHAT_IMAGE_ROUTE}/${ID}`);
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe('image/png');
    expect(head.text ?? '').toBe('');
  });

  it('returns an uncached 404 for an unknown or malformed id', async () => {
    for (const path of [
      `${CHAT_IMAGE_ROUTE}/${'b'.repeat(64)}`,
      `${CHAT_IMAGE_ROUTE}/${ID.toUpperCase()}`,
      `${CHAT_IMAGE_ROUTE}/${ID.slice(1)}`,
      `${CHAT_IMAGE_ROUTE}/..%2F..%2Fetc%2Fpasswd`,
      `${CHAT_IMAGE_ROUTE}/${ID}/extra`,
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers['cache-control'], path).toBe('no-store');
      expect(response.headers['content-type'] ?? '', path).not.toMatch(/^image\//);
    }
  });

  it('serves only reads', async () => {
    const response = await request(app).post(`${CHAT_IMAGE_ROUTE}/${ID}`);
    expect(response.status).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('applies the tRPC browser boundary: allowed or absent Origin, no rebound Host', async () => {
    const path = `${CHAT_IMAGE_ROUTE}/${ID}`;
    expect((await request(app).get(path)).status).toBe(200);
    expect((await request(app).get(path).set('Origin', ALLOWED_ORIGIN)).status).toBe(200);

    const foreign = await request(app).get(path).set('Origin', 'https://evil.example');
    expect(foreign.status).toBe(403);
    expect(foreign.headers['cache-control']).toBe('no-store');

    const rebound = await request(app).get(path).set('Host', 'evil.example:3000');
    expect(rebound.status).toBe(403);
  });

  it('refuses cross-site requests, which an <img> on another site makes without an Origin', async () => {
    const path = `${CHAT_IMAGE_ROUTE}/${ID}`;
    expect((await request(app).get(path).set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await request(app).get(path).set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
    expect((await request(app).get(path).set('Sec-Fetch-Site', 'none')).status).toBe(200);
  });

  it('accepts a rebound Host when not bound to loopback, and everything when CORS checks are off', async () => {
    const path = `${CHAT_IMAGE_ROUTE}/${ID}`;
    const exposed = setup({ backendHost: '0.0.0.0' }).app;
    expect((await request(exposed).get(path).set('Host', 'factory.example')).status).toBe(200);

    const open = setup({ cors: { disableCorsChecks: true } }).app;
    const response = await request(open)
      .get(path)
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site');
    expect(response.status).toBe(200);
  });
});
