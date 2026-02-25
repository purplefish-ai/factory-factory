import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';

const DEFAULT_TOKEN_QUERY_PARAM = 'token';
const DEFAULT_LOCAL_HOST = '127.0.0.1';
const DEFAULT_PROCESS_KILL_TIMEOUT_MS = 3000;
const DEFAULT_TUNNEL_START_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TUNNEL_OUTPUT_BUFFER_CHARS = 8192;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ProxySession {
  id: string;
  signature: string;
}

export interface AuthenticationCheck {
  authenticated: boolean;
  viaToken: boolean;
  invalidToken: boolean;
  sanitizedPath: string;
}

function parseProxyRequestUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl, 'http://proxy.local');
  } catch {
    return null;
  }
}

function sanitizeParsedPathWithoutToken(parsedUrl: URL, tokenQueryParam: string): string {
  const sanitizedUrl = new URL(parsedUrl.toString());
  sanitizedUrl.searchParams.delete(tokenQueryParam);
  const search = sanitizedUrl.searchParams.toString();
  return `${sanitizedUrl.pathname}${search ? `?${search}` : ''}`;
}

export function signValue(value: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function createSessionValue(secret: Buffer): ProxySession {
  const id = randomBytes(16).toString('hex');
  return { id, signature: signValue(id, secret) };
}

export function verifySessionValue(value: string | undefined, secret: Buffer): boolean {
  if (!value) {
    return false;
  }

  const separator = value.indexOf('.');
  if (separator <= 0 || separator === value.length - 1) {
    return false;
  }

  const id = value.slice(0, separator);
  const providedSignature = value.slice(separator + 1);
  const expectedSignature = signValue(id, secret);

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) {
        return acc;
      }

      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key) {
        acc[key] = value;
      }

      return acc;
    }, {});
}

export function mergeSetCookieValues(
  existing: string | string[] | number | undefined,
  incoming: string | string[]
): string[] {
  const existingValues =
    typeof existing === 'undefined' ? [] : Array.isArray(existing) ? existing : [String(existing)];
  const incomingValues = Array.isArray(incoming) ? incoming : [incoming];
  return [...existingValues, ...incomingValues];
}

export function matchesToken(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (candidateBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function sanitizePathWithoutToken(
  rawUrl: string,
  tokenQueryParam = DEFAULT_TOKEN_QUERY_PARAM
): string {
  const parsed = parseProxyRequestUrl(rawUrl);
  if (!parsed) {
    return '/';
  }

  return sanitizeParsedPathWithoutToken(parsed, tokenQueryParam);
}

export function toSafeRedirectPath(path: string): string {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.startsWith('/\\') ||
    /[\r\n]/.test(path)
  ) {
    return '/';
  }
  return path;
}

export function createAuthCookie(session: ProxySession, cookieName: string): string {
  return `${cookieName}=${session.id}.${session.signature}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

export function authenticateRequest(params: {
  req: IncomingMessage;
  cookieSecret: Buffer;
  authToken: string;
  sessionCookieName: string;
  tokenQueryParam?: string;
}): AuthenticationCheck {
  const tokenQueryParam = params.tokenQueryParam ?? DEFAULT_TOKEN_QUERY_PARAM;
  const rawUrl = params.req.url || '/';
  const parsed = parseProxyRequestUrl(rawUrl);
  if (!parsed) {
    return {
      authenticated: false,
      viaToken: false,
      invalidToken: false,
      sanitizedPath: '/',
    };
  }

  const sanitizedPath = sanitizeParsedPathWithoutToken(parsed, tokenQueryParam);
  const cookies = parseCookieHeader(params.req.headers.cookie);
  const session = cookies[params.sessionCookieName];
  const hasValidSession = verifySessionValue(session, params.cookieSecret);

  const token = parsed.searchParams.get(tokenQueryParam);
  if (token && matchesToken(token, params.authToken)) {
    return {
      authenticated: true,
      viaToken: true,
      invalidToken: false,
      sanitizedPath,
    };
  }

  if (token) {
    if (hasValidSession) {
      return {
        authenticated: true,
        viaToken: false,
        invalidToken: false,
        sanitizedPath,
      };
    }

    return {
      authenticated: false,
      viaToken: false,
      invalidToken: true,
      sanitizedPath,
    };
  }

  return {
    authenticated: hasValidSession,
    viaToken: false,
    invalidToken: false,
    sanitizedPath: rawUrl,
  };
}

export function removeHopByHopHeaders(
  headers: IncomingHttpHeaders,
  sessionCookieName?: string
): Record<string, string | string[] | undefined> {
  const cleaned: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }

    if (key.toLowerCase() === 'cookie' && typeof value === 'string' && sessionCookieName) {
      const cookies = parseCookieHeader(value);
      delete cookies[sessionCookieName];
      const cookieValue = Object.entries(cookies)
        .map(([cookieKey, cookieVal]) => `${cookieKey}=${cookieVal}`)
        .join('; ');
      if (cookieValue) {
        cleaned[key] = cookieValue;
      }
      continue;
    }

    cleaned[key] = value;
  }
  return cleaned;
}

export function appendBoundedOutputBuffer(
  existing: string,
  chunk: string,
  maxChars = 8192
): string {
  const combined = `${existing}${chunk}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(-maxChars);
}

export function extractTryCloudflareUrl(input: string): string | null {
  const match = input.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
  if (!match || match.length === 0) {
    return null;
  }
  return match[0] ?? null;
}

export function proxyAuthenticatedHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  upstreamPort: number;
  path: string;
  sessionCookieName: string;
  authCookie?: string;
  localHost?: string;
}): void {
  const localHost = params.localHost ?? DEFAULT_LOCAL_HOST;

  const endProxyErrorResponse = () => {
    if (!params.res.headersSent) {
      params.res.statusCode = 502;
    }
    if (!params.res.writableEnded) {
      params.res.end('Proxy error');
    }
  };

  if (params.authCookie) {
    const existingCookieHeader = params.res.getHeader('set-cookie');
    params.res.setHeader(
      'set-cookie',
      mergeSetCookieValues(existingCookieHeader, params.authCookie)
    );
  }

  const upstreamHeaders = removeHopByHopHeaders(params.req.headers, params.sessionCookieName);

  const upstreamRequest = httpRequest(
    {
      host: localHost,
      port: params.upstreamPort,
      method: params.req.method,
      path: params.path,
      headers: {
        ...upstreamHeaders,
        host: `localhost:${params.upstreamPort}`,
      },
    },
    (upstreamResponse) => {
      if (upstreamResponse.statusCode) {
        params.res.statusCode = upstreamResponse.statusCode;
      }
      for (const [header, value] of Object.entries(upstreamResponse.headers)) {
        if (typeof value === 'undefined') {
          continue;
        }

        if (header.toLowerCase() === 'set-cookie') {
          const existingCookieHeader = params.res.getHeader('set-cookie');
          const mergedCookieHeader = mergeSetCookieValues(existingCookieHeader, value);
          params.res.setHeader('set-cookie', mergedCookieHeader);
          continue;
        }

        params.res.setHeader(header, value);
      }

      upstreamResponse.on('error', endProxyErrorResponse);
      upstreamResponse.on('aborted', endProxyErrorResponse);
      upstreamResponse.pipe(params.res);
    }
  );

  upstreamRequest.on('error', endProxyErrorResponse);

  params.req.on('error', () => {
    if (!(upstreamRequest.destroyed || upstreamRequest.writableEnded)) {
      upstreamRequest.destroy();
    }
    endProxyErrorResponse();
  });

  params.req.pipe(upstreamRequest);
}

export function proxyAuthenticatedWebSocketUpgrade(params: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  upstreamPort: number;
  sanitizedPath: string;
  sessionCookieName: string;
  localHost?: string;
}): void {
  const localHost = params.localHost ?? DEFAULT_LOCAL_HOST;

  const upstreamSocket = createConnection(params.upstreamPort, localHost, () => {
    const headers: Record<string, string | string[] | undefined> = {
      ...removeHopByHopHeaders(params.req.headers, params.sessionCookieName),
      host: `localhost:${params.upstreamPort}`,
      connection: 'Upgrade',
      upgrade: params.req.headers.upgrade,
    };

    const requestPath = toSafeRedirectPath(params.sanitizedPath || '/');
    const requestLine = `${params.req.method || 'GET'} ${requestPath} HTTP/${params.req.httpVersion}`;
    const headerLines = Object.entries(headers)
      .flatMap(([key, value]) => {
        if (typeof value === 'undefined') {
          return [];
        }
        if (Array.isArray(value)) {
          return value.map((item) => `${key}: ${item}`);
        }
        return [`${key}: ${value}`];
      })
      .join('\r\n');

    upstreamSocket.write(`${requestLine}\r\n${headerLines}\r\n\r\n`);
    if (params.head.length > 0) {
      upstreamSocket.write(params.head);
    }
    params.socket.pipe(upstreamSocket).pipe(params.socket);
  });

  upstreamSocket.on('error', () => {
    params.socket.destroy();
  });

  params.socket.on('error', () => {
    upstreamSocket.destroy();
  });
}

export async function killProcessWithTimeout(
  proc: ChildProcess,
  timeoutMs = DEFAULT_PROCESS_KILL_TIMEOUT_MS
): Promise<void> {
  if (!proc.pid || proc.exitCode !== null) {
    return;
  }

  const waitForExit = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.once('error', () => resolve());
  });

  const waitForTimeout = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });

  proc.kill('SIGTERM');
  await Promise.race([waitForExit, waitForTimeout()]);

  if (proc.exitCode === null) {
    proc.kill('SIGKILL');
    await Promise.race([waitForExit, waitForTimeout()]);
  }
}

export async function startCloudflaredTunnel(params: {
  targetUrl: string;
  startTimeoutMs?: number;
  maxOutputBufferChars?: number;
  killProcess?: (proc: ChildProcess) => Promise<void>;
}): Promise<{ proc: ChildProcess; publicUrl: string }> {
  const startTimeoutMs = params.startTimeoutMs ?? DEFAULT_TUNNEL_START_TIMEOUT_MS;
  const maxOutputBufferChars =
    params.maxOutputBufferChars ?? DEFAULT_MAX_TUNNEL_OUTPUT_BUFFER_CHARS;
  const killProcess = params.killProcess ?? ((proc) => killProcessWithTimeout(proc));
  const cloudflared = spawn('cloudflared', ['tunnel', '--url', params.targetUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let resolvedUrl: string | null = null;
  let outputBuffer = '';

  const waitForUrl = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for cloudflared tunnel URL'));
    }, startTimeoutMs);
    timeout.unref?.();

    const onData = (data: Buffer) => {
      outputBuffer = appendBoundedOutputBuffer(outputBuffer, data.toString(), maxOutputBufferChars);
      const extracted = extractTryCloudflareUrl(outputBuffer);
      if (extracted && !resolvedUrl) {
        resolvedUrl = extracted;
        cleanup();
        resolve(extracted);
      }
    };

    const onExit = (code: number | null) => {
      if (!resolvedUrl) {
        cleanup();
        reject(
          new Error(`cloudflared exited before URL was available (code ${code ?? 'unknown'})`)
        );
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(new Error(`Failed to start cloudflared: ${error.message}`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      cloudflared.stdout?.off('data', onData);
      cloudflared.stderr?.off('data', onData);
      cloudflared.off('exit', onExit);
      cloudflared.off('error', onError);
    };

    cloudflared.stdout?.on('data', onData);
    cloudflared.stderr?.on('data', onData);
    cloudflared.once('exit', onExit);
    cloudflared.once('error', onError);
  });

  try {
    const publicUrl = await waitForUrl;
    return { proc: cloudflared, publicUrl };
  } catch (error) {
    await killProcess(cloudflared);
    throw error;
  }
}
