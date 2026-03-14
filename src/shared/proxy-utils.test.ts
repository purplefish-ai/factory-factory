import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { authenticateRequest, createSessionValue, sanitizePathWithoutToken } from './proxy-utils';

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
});
