import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { authenticateRequest, sanitizePathWithoutToken } from './proxy-utils';

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
});
