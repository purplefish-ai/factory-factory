import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  authenticateRequest,
  createSessionValue,
  parseCookieHeader,
  proxyAuthenticatedHttpRequest,
  proxyAuthenticatedWebSocketUpgrade,
  sanitizePathWithoutToken,
} from './proxy-utils';

describe('proxy-utils', () => {
  it('falls back to root path when sanitizing malformed URLs', () => {
    expect(sanitizePathWithoutToken('/\\')).toBe('/');
  });

  it('treats malformed auth URLs as unauthenticated instead of throwing', () => {
    const request = {
      url: '/\\',
      headers: {},
    } as IncomingMessage;

    const result = authenticateRequest({
      req: request,
      cookieSecret: Buffer.from('secret'),
      authToken: 'expected-token',
      sessionCookieName: 'session',
    });

    expect(result).toEqual({
      authenticated: false,
      viaToken: false,
      invalidToken: false,
      sanitizedPath: '/',
    });
  });

  it('sanitizes repeated token params when first token is empty', () => {
    const cookieSecret = Buffer.from('secret');
    const session = createSessionValue(cookieSecret);
    const request = {
      url: '/foo?token=&token=SECRET_TOKEN&view=kanban',
      headers: {
        cookie: `session=${session.id}.${session.signature}`,
      },
    } as IncomingMessage;

    const result = authenticateRequest({
      req: request,
      cookieSecret,
      authToken: 'expected-token',
      sessionCookieName: 'session',
    });

    expect(result).toEqual({
      authenticated: true,
      viaToken: false,
      invalidToken: false,
      sanitizedPath: '/foo?view=kanban',
    });
  });

  it('returns a sanitized relative path for absolute request URLs', () => {
    const cookieSecret = Buffer.from('secret');
    const session = createSessionValue(cookieSecret);
    const request = {
      url: 'http://evil.com/bar?token=&next=1',
      headers: {
        cookie: `session=${session.id}.${session.signature}`,
      },
    } as IncomingMessage;

    const result = authenticateRequest({
      req: request,
      cookieSecret,
      authToken: 'expected-token',
      sessionCookieName: 'session',
    });

    expect(result).toEqual({
      authenticated: true,
      viaToken: false,
      invalidToken: false,
      sanitizedPath: '/bar?next=1',
    });
  });

  it('does not forward client-address headers on WebSocket upgrades', async () => {
    const received: Buffer[] = [];
    const serverSockets: import('node:net').Socket[] = [];
    const server = createNetServer((socket) => {
      serverSockets.push(socket);
      socket.on('data', (chunk) => received.push(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (server.address() as AddressInfo).port;

    try {
      const req = {
        method: 'GET',
        httpVersion: '1.1',
        headers: {
          host: 'public.example.com',
          origin: 'http://localhost:3000',
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'abc123',
          forwarded: 'for=203.0.113.10',
          'x-forwarded-for': '203.0.113.10',
          'x-real-ip': '203.0.113.10',
          'x-client-ip': '203.0.113.10',
          'cf-connecting-ip': '203.0.113.10',
          'true-client-ip': '203.0.113.10',
        },
      } as unknown as IncomingMessage;

      proxyAuthenticatedWebSocketUpgrade({
        req,
        socket: new PassThrough(),
        head: Buffer.alloc(0),
        upstreamPort,
        sanitizedPath: '/chat',
        sessionCookieName: 'session',
      });

      await vi.waitFor(() => {
        expect(Buffer.concat(received).toString()).toContain('GET /chat HTTP/1.1');
      });

      const rawUpstreamRequest = Buffer.concat(received).toString().toLowerCase();
      expect(rawUpstreamRequest).not.toContain('forwarded');
      expect(rawUpstreamRequest).not.toContain('x-real-ip');
      expect(rawUpstreamRequest).not.toContain('x-client-ip');
      expect(rawUpstreamRequest).not.toContain('cf-connecting-ip');
      expect(rawUpstreamRequest).not.toContain('true-client-ip');
      expect(rawUpstreamRequest).toContain('origin: http://localhost:3000');
      expect(rawUpstreamRequest).toContain('sec-websocket-key: abc123');
    } finally {
      for (const socket of serverSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not forward client-address headers on HTTP requests', async () => {
    let upstreamHeaders: IncomingMessage['headers'] | undefined;
    const server = createHttpServer((req, res) => {
      upstreamHeaders = req.headers;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (server.address() as AddressInfo).port;

    try {
      const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
      req.method = 'GET';
      req.headers = {
        host: 'public.example.com',
        origin: 'http://localhost:3000',
        forwarded: 'for=203.0.113.10',
        'x-forwarded-for': '203.0.113.10',
        'x-real-ip': '203.0.113.10',
        'x-client-ip': '203.0.113.10',
        'cf-connecting-ip': '203.0.113.10',
        'true-client-ip': '203.0.113.10',
      };
      const res = new PassThrough() as unknown as Parameters<
        typeof proxyAuthenticatedHttpRequest
      >[0]['res'];
      res.getHeader = vi.fn(() => undefined);
      res.setHeader = vi.fn();
      res.writeHead = vi.fn();
      req.end();

      proxyAuthenticatedHttpRequest({
        req,
        res,
        upstreamPort,
        path: '/api/health',
        sessionCookieName: 'session',
      });

      await vi.waitFor(() => {
        expect(upstreamHeaders).toBeDefined();
      });

      expect(upstreamHeaders).not.toHaveProperty('forwarded');
      expect(upstreamHeaders).not.toHaveProperty('x-forwarded-for');
      expect(upstreamHeaders).not.toHaveProperty('x-real-ip');
      expect(upstreamHeaders).not.toHaveProperty('x-client-ip');
      expect(upstreamHeaders).not.toHaveProperty('cf-connecting-ip');
      expect(upstreamHeaders).not.toHaveProperty('true-client-ip');
      expect(upstreamHeaders?.origin).toBe('http://localhost:3000');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns null-prototype cookie maps for empty and parsed headers', () => {
    const emptyCookies = parseCookieHeader(undefined);
    const parsedCookies = parseCookieHeader('session=abc; theme=dark');

    expect(Object.getPrototypeOf(emptyCookies)).toBeNull();
    expect(Object.getPrototypeOf(parsedCookies)).toBeNull();
    expect(emptyCookies.constructor).toBeUndefined();
    expect(parsedCookies.session).toBe('abc');
    expect(parsedCookies.theme).toBe('dark');
  });
});
