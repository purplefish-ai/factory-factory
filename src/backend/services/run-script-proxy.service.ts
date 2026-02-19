import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { Socket } from 'node:net';
import {
  authenticateRequest,
  createAuthCookie,
  createSessionValue,
  killProcessWithTimeout,
  proxyAuthenticatedHttpRequest,
  proxyAuthenticatedWebSocketUpgrade,
  startCloudflaredTunnel,
} from '@/shared/proxy-utils';
import { createLogger } from './logger.service';

const logger = createLogger('run-script-proxy-service');

const LOCAL_HOST = '127.0.0.1';
const TOKEN_QUERY_PARAM = 'token';
const SESSION_COOKIE_NAME = 'ff_run_proxy_session';

interface ActiveTunnel {
  upstreamPort: number;
  publicUrl: string;
  authenticatedUrl: string;
  cloudflaredProcess: ChildProcess;
  closeAuthProxy: () => Promise<void>;
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
      sessionCookieName: SESSION_COOKIE_NAME,
      localHost: LOCAL_HOST,
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

    proxyAuthenticatedWebSocketUpgrade({
      req,
      socket,
      head,
      upstreamPort: params.upstreamPort,
      sanitizedPath: auth.sanitizedPath,
      sessionCookieName: SESSION_COOKIE_NAME,
      localHost: LOCAL_HOST,
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
      const tunnel = await startCloudflaredTunnel({
        targetUrl: `http://${LOCAL_HOST}:${authProxy.port}`,
      });
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

  cleanupSync(): void {
    for (const [workspaceId, tunnel] of this.tunnels.entries()) {
      this.tunnels.delete(workspaceId);

      try {
        if (tunnel.cloudflaredProcess.pid && tunnel.cloudflaredProcess.exitCode === null) {
          tunnel.cloudflaredProcess.kill('SIGKILL');
        }
      } catch {
        // Ignore errors during forced shutdown
      }

      try {
        void tunnel.closeAuthProxy();
      } catch {
        // Ignore errors during forced shutdown
      }
    }
  }
}

export const runScriptProxyService = new RunScriptProxyService();
