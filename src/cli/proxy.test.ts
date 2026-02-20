import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { proxyInternals } from './proxy';

interface HttpResponse {
  body: string;
  headers: IncomingHttpHeaders;
  statusCode: number;
}

function sendHttpRequest(params: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: params.port,
        method: params.method ?? 'GET',
        path: params.path,
        headers: params.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
            statusCode: res.statusCode ?? 0,
          });
        });
      }
    );

    req.on('error', reject);
    if (params.body) {
      req.write(params.body);
    }
    req.end();
  });
}

function getCookieHeaderFromSetCookie(value: string | string[] | undefined): string {
  if (!value) {
    return '';
  }
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(';')[0] ?? '';
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('proxy internals', () => {
  it('generates a six-character alphanumeric password', () => {
    const password = proxyInternals.generatePassword();

    expect(password).toHaveLength(6);
    expect(password).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('generates a 128-bit magic token as hex', () => {
    const token = proxyInternals.generateMagicToken();

    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
  });

  it('detects terminal support for QR rendering', () => {
    expect(
      proxyInternals.supportsTerminalQrRendering(
        { isTTY: true } as Pick<NodeJS.WriteStream, 'isTTY'>,
        { TERM: 'xterm-256color' }
      )
    ).toBe(true);
    expect(
      proxyInternals.supportsTerminalQrRendering(
        { isTTY: false } as Pick<NodeJS.WriteStream, 'isTTY'>,
        { TERM: 'xterm-256color' }
      )
    ).toBe(false);
    expect(
      proxyInternals.supportsTerminalQrRendering(
        { isTTY: true } as Pick<NodeJS.WriteStream, 'isTTY'>,
        { TERM: 'dumb' }
      )
    ).toBe(false);
  });

  it('renders terminal QR code output with qrencode', () => {
    let invokedFile: string | undefined;
    let invokedArgs: readonly string[] | undefined;

    const rendered = proxyInternals.tryRenderTerminalQrCode(
      'https://example.trycloudflare.com?token=abc123',
      ((file: string, args: readonly string[]) => {
        invokedFile = file;
        invokedArgs = args;
        return '██\n██\n';
      }) as unknown as typeof import('node:child_process').execFileSync
    );

    expect(invokedFile).toBe('qrencode');
    expect(invokedArgs).toEqual([
      '-t',
      'UTF8',
      '-m',
      '1',
      'https://example.trycloudflare.com?token=abc123',
    ]);
    expect(rendered).toBe('██\n██\n');
  });

  it('returns null when qrencode is unavailable', () => {
    const rendered = proxyInternals.tryRenderTerminalQrCode(
      'https://example.trycloudflare.com?token=abc123',
      ((_file: string, _args: readonly string[]) => {
        throw new Error('missing');
      }) as unknown as typeof import('node:child_process').execFileSync
    );

    expect(rendered).toBeNull();
  });

  it('signs and verifies session values', () => {
    const secret = Buffer.from('super-secret-key');
    const session = proxyInternals.createSessionValue(secret);
    const cookieValue = `${session.id}.${session.signature}`;

    expect(proxyInternals.verifySessionValue(cookieValue, secret)).toBe(true);
    expect(proxyInternals.verifySessionValue(`${session.id}.tampered`, secret)).toBe(false);
  });

  it('creates auth cookies with secure attributes', () => {
    const secret = Buffer.from('super-secret-key');
    const session = proxyInternals.createSessionValue(secret);
    const cookie = proxyInternals.createAuthCookie(session);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('extracts trycloudflare URL from mixed output', () => {
    const output =
      'INF Starting\nINF Visit this URL to access your application: https://abc-xyz.trycloudflare.com';

    expect(proxyInternals.extractTryCloudflareUrl(output)).toBe(
      'https://abc-xyz.trycloudflare.com'
    );
  });

  it('extracts trycloudflare URL when output arrives across chunks', () => {
    let outputBuffer = '';

    outputBuffer = proxyInternals.appendBoundedOutputBuffer(
      outputBuffer,
      'INF Visit this URL to access your application: https://abc-'
    );
    expect(proxyInternals.extractTryCloudflareUrl(outputBuffer)).toBeNull();

    outputBuffer = proxyInternals.appendBoundedOutputBuffer(outputBuffer, 'xyz.trycloudflare.com');
    expect(proxyInternals.extractTryCloudflareUrl(outputBuffer)).toBe(
      'https://abc-xyz.trycloudflare.com'
    );
  });

  it('tracks and expires per-IP lockout', () => {
    const guard = new proxyInternals.BruteForceGuard();
    const ip = '203.0.113.10';

    const first = guard.registerFailure(ip, 0);
    expect(first.ipLocked).toBe(false);

    for (let i = 1; i < 4; i += 1) {
      const result = guard.registerFailure(ip, i);
      expect(result.ipLocked).toBe(false);
    }

    const fifth = guard.registerFailure(ip, 5);
    expect(fifth.ipLocked).toBe(true);

    const lockedState = guard.isLocked(ip, 6);
    expect(lockedState.locked).toBe(true);

    const unlockedState = guard.isLocked(ip, 5 * 60 * 1000 + 10);
    expect(unlockedState.locked).toBe(false);
  });

  it('allows only safe relative redirect paths', () => {
    expect(proxyInternals.toSafeRedirectPath('/')).toBe('/');
    expect(proxyInternals.toSafeRedirectPath('/dashboard?tab=1')).toBe('/dashboard?tab=1');
    expect(proxyInternals.toSafeRedirectPath('//evil.example')).toBe('/');
    expect(proxyInternals.toSafeRedirectPath('/\\evil.example')).toBe('/');
    expect(proxyInternals.toSafeRedirectPath('/safe\r\nx-injected: value')).toBe('/');
    expect(proxyInternals.toSafeRedirectPath('https://evil.example')).toBe('/');
  });

  it('matches magic tokens using constant-time comparison semantics', () => {
    const token = 'ABC123XYZ789';
    expect(proxyInternals.matchesMagicToken(token, token)).toBe(true);
    expect(proxyInternals.matchesMagicToken(token, 'ABC123XYZ780')).toBe(false);
    expect(proxyInternals.matchesMagicToken(token, 'SHORT')).toBe(false);
  });

  it('accepts valid cookie even when token query is invalid', () => {
    const cookieSecret = Buffer.from('super-secret-key');
    const session = proxyInternals.createSessionValue(cookieSecret);
    const request = {
      url: '/dashboard?token=invalid-token',
      headers: {
        cookie: proxyInternals.createAuthCookie(session),
      },
    } as unknown as import('node:http').IncomingMessage;

    const result = proxyInternals.authenticateRequest({
      req: request,
      cookieSecret,
      magicToken: 'expected-token',
    });

    expect(result.authenticated).toBe(true);
    expect(result.viaToken).toBe(false);
    expect(result.invalidToken).toBe(false);
    expect(result.sanitizedPath).toBe('/dashboard');
  });

  it('marks invalid token as unauthenticated when no valid cookie exists', () => {
    const request = {
      url: '/dashboard?token=invalid-token',
      headers: {},
    } as unknown as import('node:http').IncomingMessage;

    const result = proxyInternals.authenticateRequest({
      req: request,
      cookieSecret: Buffer.from('super-secret-key'),
      magicToken: 'expected-token',
    });

    expect(result.authenticated).toBe(false);
    expect(result.invalidToken).toBe(true);
    expect(result.sanitizedPath).toBe('/dashboard');
  });

  it('escapes HTML in login error messages', () => {
    const html = proxyInternals.createLoginPage('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('merges auth and upstream set-cookie headers', () => {
    expect(proxyInternals.mergeSetCookieValues(undefined, 'upstream=1')).toEqual(['upstream=1']);
    expect(proxyInternals.mergeSetCookieValues('auth=1', 'upstream=1')).toEqual([
      'auth=1',
      'upstream=1',
    ]);
    expect(proxyInternals.mergeSetCookieValues(['auth=1'], ['upstream=1', 'upstream=2'])).toEqual([
      'auth=1',
      'upstream=1',
      'upstream=2',
    ]);
  });

  it('auth proxy strips token from proxied path and reuses session cookie', async () => {
    const seenPaths: string[] = [];
    const upstream = createServer((req, res) => {
      seenPaths.push(req.url || '/');
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('Missing upstream address');
    }

    const authProxy = await proxyInternals.createAuthProxy({
      upstreamPort: upstreamAddress.port,
      password: 'ABC123',
      magicToken: 'valid-token',
    });

    try {
      const firstResponse = await sendHttpRequest({
        port: authProxy.port,
        path: '/dashboard?view=kanban&token=valid-token',
      });
      expect(firstResponse.statusCode).toBe(200);
      expect(seenPaths[0]).toBe('/dashboard?view=kanban');

      const cookie = getCookieHeaderFromSetCookie(firstResponse.headers['set-cookie']);
      expect(cookie).toContain('ff_proxy_session=');

      const secondResponse = await sendHttpRequest({
        port: authProxy.port,
        path: '/dashboard?view=timeline',
        headers: { cookie },
      });
      expect(secondResponse.statusCode).toBe(200);
      expect(seenPaths[1]).toBe('/dashboard?view=timeline');
    } finally {
      await authProxy.close();
      await closeServer(upstream);
    }
  });

  it('rate-limits a locked IP without shutting down access for other IPs', async () => {
    const upstream = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('Missing upstream address');
    }

    const authProxy = await proxyInternals.createAuthProxy({
      upstreamPort: upstreamAddress.port,
      password: 'ABC123',
      magicToken: 'valid-token',
    });

    try {
      for (let i = 0; i < 4; i += 1) {
        const response = await sendHttpRequest({
          port: authProxy.port,
          method: 'POST',
          path: '/__proxy_auth/login',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'cf-connecting-ip': '198.51.100.10',
          },
          body: 'password=BAD000',
        });
        expect(response.statusCode).toBe(401);
      }

      const lockoutResponse = await sendHttpRequest({
        port: authProxy.port,
        method: 'POST',
        path: '/__proxy_auth/login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-connecting-ip': '198.51.100.10',
        },
        body: 'password=BAD000',
      });
      expect(lockoutResponse.statusCode).toBe(429);

      const otherIpResponse = await sendHttpRequest({
        port: authProxy.port,
        path: '/?token=valid-token',
        headers: { 'cf-connecting-ip': '198.51.100.20' },
      });
      expect(otherIpResponse.statusCode).toBe(200);
    } finally {
      await authProxy.close();
      await closeServer(upstream);
    }
  });
});
