import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

const DEFAULT_TOKEN_QUERY_PARAM = 'token';

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
  const parsed = new URL(rawUrl, 'http://proxy.local');
  parsed.searchParams.delete(tokenQueryParam);
  const search = parsed.searchParams.toString();
  return `${parsed.pathname}${search ? `?${search}` : ''}`;
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
  const parsed = new URL(rawUrl, 'http://proxy.local');
  const sanitizedPath = sanitizePathWithoutToken(rawUrl, tokenQueryParam);
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
