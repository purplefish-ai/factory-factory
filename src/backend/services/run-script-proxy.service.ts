import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import { createConnection, type Socket } from 'node:net';
import {
  appendBoundedOutputBuffer,
  authenticateRequest,
  createAuthCookie,
  createSessionValue,
  extractTryCloudflareUrl,
  mergeSetCookieValues,
  removeHopByHopHeaders,
  toSafeRedirectPath,
} from '@/shared/proxy-utils';
import { createLogger } from './logger.service';

const logger = createLogger('run-script-proxy-service');

const LOCAL_HOST = '127.0.0.1';
const TOKEN_QUERY_PARAM = 'token';
const SESSION_COOKIE_NAME = 'ff_run_proxy_session';
const MAX_TUNNEL_OUTPUT_BUFFER_CHARS = 8192;
const TUNNEL_START_TIMEOUT_MS = 30_000;
const PROCESS_KILL_TIMEOUT_MS = 3000;

interface ActiveTunnel {
  upstreamPort: number;
  publicUrl: string;
  authenticatedUrl: string;
  cloudflaredProcess: ChildProcess;
  closeAuthProxy: () => Promise<void>;
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

  const upstreamHeaders = removeHopByHopHeaders(params.req.headers, SESSION_COOKIE_NAME);

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
      outputBuffer = appendBoundedOutputBuffer(
        outputBuffer,
        data.toString(),
        MAX_TUNNEL_OUTPUT_BUFFER_CHARS
      );
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
      sessionCookieName: SESSION_COOKIE_NAME,
      tokenQueryParam: TOKEN_QUERY_PARAM,
    });

    if (!auth.authenticated) {
      writeUnauthorizedResponse(res, auth.invalidToken);
      return;
    }

    const authCookie = auth.viaToken
      ? createAuthCookie(createSessionValue(cookieSecret), SESSION_COOKIE_NAME)
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
      sessionCookieName: SESSION_COOKIE_NAME,
      tokenQueryParam: TOKEN_QUERY_PARAM,
    });

    if (!auth.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const upstreamSocket = createConnection(params.upstreamPort, LOCAL_HOST, () => {
      const headers: Record<string, string | string[] | undefined> = {
        ...removeHopByHopHeaders(req.headers, SESSION_COOKIE_NAME),
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
