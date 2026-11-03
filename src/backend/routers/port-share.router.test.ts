import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { PortShareError } from '@/backend/services/port-share';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { buildShareLocation, createPortShareRouter } from './port-share.router';

const tailscale = {
  origin: 'https://mac.tail123.ts.net',
  hostname: 'mac.tail123.ts.net',
  httpsPort: 443,
};
const ensure = vi.fn();
let available = true;

function createApp() {
  const app = express();
  const appContext = unsafeCoerce<AppContext>({
    services: {
      configService: { getTailscaleConfig: () => (available ? tailscale : null) },
      createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      portShareService: {
        isAvailable: () => available,
        getShareOrigin: (port: number) => (available ? `https://mac.tail123.ts.net:${port}` : null),
        ensure,
      },
    },
  });
  app.use('/proxy', createPortShareRouter(appContext));
  return app;
}

const sameOriginNavigation = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' };

describe('port share router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    available = true;
    ensure.mockImplementation((port: number) =>
      Promise.resolve(`https://mac.tail123.ts.net:${port}`)
    );
  });

  it('shares on navigations from Factory Factory and keeps the path and query', async () => {
    const response = await request(createApp())
      .get('/proxy/6173/?path=/story/chat-streaming-markdown-comparison--prose')
      .set(sameOriginNavigation);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(
      'https://mac.tail123.ts.net:6173/?path=/story/chat-streaming-markdown-comparison--prose'
    );
    expect(ensure).toHaveBeenCalledWith(6173);
  });

  it('defaults to the root path and accepts typed or bookmarked visits', async () => {
    const response = await request(createApp())
      .get('/proxy/5173')
      .set({ 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' });
    expect(response.headers.location).toBe('https://mac.tail123.ts.net:5173/');
  });

  it.each([
    {
      name: 'cross-site navigation',
      headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' },
    },
    {
      name: 'subresource',
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors' },
    },
    { name: 'prefetch', headers: { ...sameOriginNavigation, 'Sec-Purpose': 'prefetch' } },
    { name: 'request without fetch metadata', headers: {} },
  ])('asks for confirmation instead of sharing on a $name', async ({ headers }) => {
    const response = await request(createApp()).get('/proxy/6173/a').set(headers);
    expect(response.status).toBe(200);
    expect(response.text).toContain('Share port 6173?');
    expect(response.text).toContain('<form method="post">');
    expect(response.headers['content-security-policy']).toContain(
      "form-action 'self' https://mac.tail123.ts.net:6173"
    );
    expect(ensure).not.toHaveBeenCalled();
  });

  it('shares on a confirmation POST from the Factory Factory origin only', async () => {
    const rejected = await request(createApp())
      .post('/proxy/6173/a?b=1')
      .set('Origin', 'https://evil.example');
    expect(rejected.status).toBe(403);
    expect(ensure).not.toHaveBeenCalled();

    const accepted = await request(createApp())
      .post('/proxy/6173/a?b=1')
      .set('Origin', tailscale.origin);
    expect(accepted.status).toBe(303);
    expect(accepted.headers.location).toBe('https://mac.tail123.ts.net:6173/a?b=1');
  });

  it.each(['/proxy/0/', '/proxy/065/', '/proxy/70000/', '/proxy/abc/', '/proxy/'])(
    'rejects the invalid link %s',
    async (path) => {
      const response = await request(createApp()).get(path).set(sameOriginNavigation);
      expect(response.status).toBe(400);
      expect(ensure).not.toHaveBeenCalled();
    }
  );

  it('keeps path tricks on the share origin', async () => {
    const response = await request(createApp())
      .get('/proxy/6173//evil.example/x')
      .set(sameOriginNavigation);
    expect(response.headers.location).toBe('https://mac.tail123.ts.net:6173//evil.example/x');
  });

  it('is off outside ff tailscale', async () => {
    available = false;
    const response = await request(createApp()).get('/proxy/6173/').set(sameOriginNavigation);
    expect(response.status).toBe(404);
    expect(response.text).toContain('ff tailscale');
  });

  it('explains share failures', async () => {
    ensure.mockRejectedValue(
      new PortShareError('NOT_LISTENING', 'Nothing is listening on port 6173 on the host.')
    );
    const response = await request(createApp()).get('/proxy/6173/').set(sameOriginNavigation);
    expect(response.status).toBe(502);
    expect(response.text).toContain('Nothing is listening on port 6173 on the host.');
  });

  it('escapes paths shown on the confirmation page', async () => {
    const response = await request(createApp()).get('/proxy/6173/%3Cscript%3E?q=%22%3E');
    expect(response.text).not.toContain('<script>');
  });
});

describe('buildShareLocation', () => {
  it('only produces locations on the share origin', () => {
    const origin = 'https://mac.tail123.ts.net:6173';
    expect(buildShareLocation(origin, '/a?b#c')).toBe(`${origin}/a?b#c`);
    expect(buildShareLocation(origin, 'evil.example')).toBeNull();
    expect(buildShareLocation(origin, '/a\r\nSet-Cookie: x')).toBeNull();
    expect(buildShareLocation(origin, '/\\evil.example')).toBeNull();
  });
});
