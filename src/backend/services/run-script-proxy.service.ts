import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { createLogger } from './logger.service';

const logger = createLogger('run-script-proxy-service');

const LOCAL_HOST = '127.0.0.1';
const TOKEN_QUERY_PARAM = 'token';
const SESSION_COOKIE_NAME = 'ff_run_proxy_session';
const MAX_TUNNEL_OUTPUT_BUFFER_CHARS = 8192;
const TUNNEL_START_TIMEOUT_MS = 30_000;
const PROCESS_KILL_TIMEOUT_MS = 3000;

interface ProxySession {
  id: string;
  signature: string;
}

interface AuthenticationCheck {
  authenticated: boolean;
  viaToken: boolean;
  invalidToken: boolean;
  sanitizedPath: string;
}

interface ActiveTunnel {
  upstreamPort: number;
  publicUrl: string;
  authenticatedUrl: string;
  cloudflaredProcess: ChildProcess;
  closeAuthProxy: () => Promise<void>;
}

function signValue(value: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function createSessionValue(secret: Buffer): ProxySession {
  const id = randomBytes(16).toString('hex');
  return { id, signature: signValue(id, secret) };
}

function verifySessionValue(value: string | undefined, secret: Buffer): boolean {
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

  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(providedSignature);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
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

function mergeSetCookieValues(
  existing: string | string[] | number | undefined,
  incoming: string | string[]
): string[] {
  const existingValues =
    typeof existing === 'undefined' ? [] : Array.isArray(existing) ? existing : [String(existing)];
  const incomingValues = Array.isArray(incoming) ? incoming : [incoming];
  return [...existingValues, ...incomingValues];
}

function matchesToken(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (candidateBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function sanitizePathWithoutToken(rawUrl: string): string {
  const parsed = new URL(rawUrl, 'http://proxy.local');
  parsed.searchParams.delete(TOKEN_QUERY_PARAM);
  const search = parsed.searchParams.toString();
  return `${parsed.pathname}${search ? `?${search}` : ''}`;
}

function toSafeRedirectPath(path: string): string {
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

function createAuthCookie(session: ProxySession): string {
  return `${SESSION_COOKIE_NAME}=${session.id}.${session.signature}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

function authenticateRequest(params: {
  req: IncomingMessage;
  cookieSecret: Buffer;
  authToken: string;
}): AuthenticationCheck {
  const rawUrl = params.req.url || '/';
  const parsed = new URL(rawUrl, 'http://proxy.local');
  const sanitizedPath = sanitizePathWithoutToken(rawUrl);
  const cookies = parseCookieHeader(params.req.headers.cookie);
  const session = cookies[SESSION_COOKIE_NAME];
  const hasValidSession = verifySessionValue(session, params.cookieSecret);

  const token = parsed.searchParams.get(TOKEN_QUERY_PARAM);
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

function removeHopByHopHeaders(
  headers: IncomingMessage['headers']
): Record<string, string | string[] | undefined> {
  const disallowed = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);

  const cleaned: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (disallowed.has(key.toLowerCase())) {
      continue;
    }

    if (key.toLowerCase() === 'cookie' && typeof value === 'string') {
      const cookies = parseCookieHeader(value);
      delete cookies[SESSION_COOKIE_NAME];
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

function proxyAuthenticatedHttpRequest(params: {
  req: IncomingMessage;
  res: import('node:http').ServerResponse;
  upstreamPort: number;
  path: string;
  authCookie?: string;
}): void {
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

  const upstreamHeaders = removeHopByHopHeaders(params.req.headers);

  const upstreamRequest = httpRequest(
    {
      host: LOCAL_HOST,
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
        if (typeof value !== 'undefined') {
          if (header.toLowerCase() === 'set-cookie') {
            const existingCookieHeader = params.res.getHeader('set-cookie');
            const mergedCookieHeader = mergeSetCookieValues(existingCookieHeader, value);
            params.res.setHeader('set-cookie', mergedCookieHeader);
          } else {
            params.res.setHeader(header, value);
          }
        }
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

function writeUnauthorizedResponse(
  res: import('node:http').ServerResponse,
  invalidToken: boolean
): void {
  res.statusCode = 401;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(invalidToken ? 'Invalid auth token' : 'Authentication required');
}

function appendBoundedOutputBuffer(
  existing: string,
  chunk: string,
  maxChars = MAX_TUNNEL_OUTPUT_BUFFER_CHARS
): string {
  const combined = `${existing}${chunk}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(-maxChars);
}

function extractTryCloudflareUrl(input: string): string | null {
  const match = input.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
  if (!match || match.length === 0) {
    return null;
  }
  return match[0] ?? null;
}

function isCommandNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /ENOENT|command not found/i.test(error.message);
}

async function killProcessWithTimeout(proc: ChildProcess): Promise<void> {
  if (!proc.pid || proc.exitCode !== null) {
    return;
  }

  const waitForExit = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.once('error', () => resolve());
  });

  const waitForTimeout = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PROCESS_KILL_TIMEOUT_MS);
      timer.unref?.();
    });

  proc.kill('SIGTERM');

  await Promise.race([waitForExit, waitForTimeout()]);

  if (proc.exitCode === null) {
    proc.kill('SIGKILL');
    await Promise.race([waitForExit, waitForTimeout()]);
  }
}

async function startCloudflaredTunnel(
  targetUrl: string
): Promise<{ proc: ChildProcess; publicUrl: string }> {
  const cloudflared = spawn('cloudflared', ['tunnel', '--url', targetUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let resolvedUrl: string | null = null;
  let outputBuffer = '';

  const waitForUrl = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for cloudflared tunnel URL'));
    }, TUNNEL_START_TIMEOUT_MS);
    timeout.unref?.();

    const onData = (data: Buffer) => {
      outputBuffer = appendBoundedOutputBuffer(outputBuffer, data.toString());
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
    await killProcessWithTimeout(cloudflared);
    throw error;
  }
}

function createTokenAuthProxy(params: {
  upstreamPort: number;
  authToken: string;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const cookieSecret = randomBytes(32);
  const activeSockets = new Set<Socket>();

  const server = createHttpServer((req, res) => {
    const auth = authenticateRequest({
      req,
      cookieSecret,
      authToken: params.authToken,
    });

    if (!auth.authenticated) {
      writeUnauthorizedResponse(res, auth.invalidToken);
      return;
    }

    const authCookie = auth.viaToken
      ? createAuthCookie(createSessionValue(cookieSecret))
      : undefined;
    proxyAuthenticatedHttpRequest({
      req,
      res,
      upstreamPort: params.upstreamPort,
      path: auth.sanitizedPath,
      authCookie,
    });
  });

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => {
      activeSockets.delete(socket);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const auth = authenticateRequest({
      req,
      cookieSecret,
      authToken: params.authToken,
    });

    if (!auth.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const upstreamSocket = createConnection(params.upstreamPort, LOCAL_HOST, () => {
      const headers: Record<string, string | string[] | undefined> = {
        ...removeHopByHopHeaders(req.headers),
        host: `localhost:${params.upstreamPort}`,
        connection: 'Upgrade',
        upgrade: req.headers.upgrade,
      };

      const requestPath = toSafeRedirectPath(auth.sanitizedPath || '/');
      const requestLine = `${req.method || 'GET'} ${requestPath} HTTP/${req.httpVersion}`;
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
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      socket.pipe(upstreamSocket).pipe(socket);
    });

    upstreamSocket.on('error', () => {
      socket.destroy();
    });

    socket.on('error', () => {
      upstreamSocket.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOCAL_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine auth proxy port'));
        return;
      }

      resolve({
        port: address.port,
        close: async () => {
          await new Promise<void>((closeResolve) => {
            const timeout = setTimeout(() => {
              closeResolve();
            }, 1000);
            timeout.unref?.();

            server.close(() => {
              clearTimeout(timeout);
              closeResolve();
            });

            for (const socket of activeSockets) {
              socket.destroy();
            }
          });
        },
      });
    });
  });
}

export class RunScriptProxyService {
  private readonly tunnels = new Map<string, ActiveTunnel>();

  private cloudflaredUnavailable = false;

  private isEnabled(): boolean {
    return process.env.FF_RUN_SCRIPT_PROXY_ENABLED === '1';
  }

  getTunnelUrl(workspaceId: string): string | null {
    return this.tunnels.get(workspaceId)?.authenticatedUrl ?? null;
  }

  async ensureTunnel(workspaceId: string, upstreamPort: number): Promise<string | null> {
    if (!this.isEnabled() || this.cloudflaredUnavailable) {
      return null;
    }

    const existing = this.tunnels.get(workspaceId);
    if (existing && existing.upstreamPort === upstreamPort) {
      return existing.authenticatedUrl;
    }

    if (existing) {
      await this.stopTunnel(workspaceId);
    }

    const authToken = randomBytes(16).toString('hex');

    let authProxy: { port: number; close: () => Promise<void> } | null = null;
    let cloudflaredProcess: ChildProcess | null = null;
    try {
      authProxy = await createTokenAuthProxy({ upstreamPort, authToken });
      const tunnel = await startCloudflaredTunnel(`http://${LOCAL_HOST}:${authProxy.port}`);
      cloudflaredProcess = tunnel.proc;

      const authenticatedUrl = `${tunnel.publicUrl}?${TOKEN_QUERY_PARAM}=${authToken}`;
      this.tunnels.set(workspaceId, {
        upstreamPort,
        publicUrl: tunnel.publicUrl,
        authenticatedUrl,
        cloudflaredProcess,
        closeAuthProxy: authProxy.close,
      });

      logger.info('Started run-script proxy tunnel', {
        workspaceId,
        upstreamPort,
        publicUrl: tunnel.publicUrl,
      });

      return authenticatedUrl;
    } catch (error) {
      if (isCommandNotFoundError(error)) {
        this.cloudflaredUnavailable = true;
      }

      logger.warn('Failed to start run-script proxy tunnel', {
        workspaceId,
        upstreamPort,
        error: error instanceof Error ? error.message : String(error),
      });

      if (cloudflaredProcess) {
        await killProcessWithTimeout(cloudflaredProcess);
      }
      if (authProxy) {
        await authProxy.close().catch(() => undefined);
      }

      return null;
    }
  }

  async stopTunnel(workspaceId: string): Promise<void> {
    const existing = this.tunnels.get(workspaceId);
    if (!existing) {
      return;
    }

    this.tunnels.delete(workspaceId);

    await Promise.allSettled([
      killProcessWithTimeout(existing.cloudflaredProcess),
      existing.closeAuthProxy(),
    ]);

    logger.info('Stopped run-script proxy tunnel', {
      workspaceId,
      upstreamPort: existing.upstreamPort,
      publicUrl: existing.publicUrl,
    });
  }

  async cleanup(): Promise<void> {
    const workspaceIds = Array.from(this.tunnels.keys());
    await Promise.all(workspaceIds.map((workspaceId) => this.stopTunnel(workspaceId)));
  }
}

export const runScriptProxyService = new RunScriptProxyService();
