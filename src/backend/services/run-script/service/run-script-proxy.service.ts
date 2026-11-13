import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import {
  authenticateRequest,
  createAuthCookie,
  createSessionValue,
  killProcessWithTimeout,
  proxyAuthenticatedHttpRequest,
  proxyAuthenticatedWebSocketUpgrade,
  startCloudflaredTunnel,
} from '@/shared/proxy-utils';

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
  leases: number;
  disposed: boolean;
  disposal?: Promise<void>;
}

interface PendingTunnel {
  closeAuthProxy?: () => Promise<void>;
}

export interface RunScriptTunnelLease {
  url: string;
  release(): Promise<void>;
}

function writeUnauthorizedResponse(
  res: import('node:http').ServerResponse,
  invalidToken: boolean
): void {
  res.statusCode = 401;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(invalidToken ? 'Invalid auth token' : 'Authentication required');
}

function writeBadRequestResponse(res: import('node:http').ServerResponse): void {
  res.statusCode = 400;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Bad request');
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
    let auth: ReturnType<typeof authenticateRequest>;
    try {
      auth = authenticateRequest({
        req,
        cookieSecret,
        authToken: params.authToken,
        sessionCookieName: SESSION_COOKIE_NAME,
        tokenQueryParam: TOKEN_QUERY_PARAM,
      });
    } catch (error) {
      logger.warn('Rejected malformed HTTP request for run-script proxy', {
        error: error instanceof Error ? error.message : String(error),
      });
      writeBadRequestResponse(res);
      return;
    }

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
    let auth: ReturnType<typeof authenticateRequest>;
    try {
      auth = authenticateRequest({
        req,
        cookieSecret,
        authToken: params.authToken,
        sessionCookieName: SESSION_COOKIE_NAME,
        tokenQueryParam: TOKEN_QUERY_PARAM,
      });
    } catch (error) {
      logger.warn('Rejected malformed upgrade request for run-script proxy', {
        error: error instanceof Error ? error.message : String(error),
      });
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

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

  private readonly pendingTunnels = new Map<string, PendingTunnel>();

  private cloudflaredUnavailable = false;

  private isEnabled(): boolean {
    return configService.isRunScriptProxyEnabled();
  }

  getTunnelUrl(workspaceId: string): string | null {
    return this.tunnels.get(workspaceId)?.authenticatedUrl ?? null;
  }

  private watchTunnelExit(workspaceId: string, tunnel: ActiveTunnel): boolean {
    const { cloudflaredProcess, closeAuthProxy } = tunnel;
    let exitHandled = false;
    const handleExit = () => {
      if (exitHandled) {
        return;
      }
      exitHandled = true;

      const current = this.tunnels.get(workspaceId);
      if (current === tunnel) {
        this.tunnels.delete(workspaceId);
      }

      if (!tunnel.disposed) {
        tunnel.disposed = true;
        tunnel.disposal = closeAuthProxy().catch(() => undefined);
      }
    };
    cloudflaredProcess.once('exit', handleExit);
    if (cloudflaredProcess.exitCode !== null || cloudflaredProcess.signalCode !== null) {
      handleExit();
    }
    return !exitHandled;
  }

  private createLease(workspaceId: string, tunnel: ActiveTunnel): RunScriptTunnelLease {
    tunnel.leases += 1;
    let release: Promise<void> | undefined;
    return {
      url: tunnel.authenticatedUrl,
      release: () => {
        if (!release) {
          tunnel.leases -= 1;
          release =
            tunnel.leases === 0 ? this.disposeTunnel(workspaceId, tunnel) : Promise.resolve();
        }
        return release;
      },
    };
  }

  async acquireTunnel(
    workspaceId: string,
    upstreamPort: number
  ): Promise<RunScriptTunnelLease | null> {
    if (!this.isEnabled() || this.cloudflaredUnavailable) {
      return null;
    }

    const existing = this.tunnels.get(workspaceId);
    if (existing && existing.upstreamPort === upstreamPort) {
      return this.createLease(workspaceId, existing);
    }

    // Install ownership before awaiting predecessor cleanup or either startup step.
    const previousPending = this.pendingTunnels.get(workspaceId);
    const pending: PendingTunnel = {};
    this.pendingTunnels.set(workspaceId, pending);
    try {
      if (previousPending?.closeAuthProxy) {
        await previousPending.closeAuthProxy().catch(() => undefined);
      }
      if (existing) {
        await this.disposeTunnel(workspaceId, existing);
      }
      if (this.pendingTunnels.get(workspaceId) !== pending) {
        return null;
      }
      return await this.startOwnedTunnel(workspaceId, upstreamPort, pending);
    } finally {
      if (this.pendingTunnels.get(workspaceId) === pending) {
        this.pendingTunnels.delete(workspaceId);
      }
    }
  }

  private async startOwnedTunnel(
    workspaceId: string,
    upstreamPort: number,
    pending: PendingTunnel
  ): Promise<RunScriptTunnelLease | null> {
    const authToken = randomBytes(16).toString('hex');
    let authProxyClose: (() => Promise<void>) | null = null;
    let cloudflaredProcess: ChildProcess | null = null;
    try {
      const authProxy = await createTokenAuthProxy({ upstreamPort, authToken });
      let closePromise: Promise<void> | undefined;
      const closeAuthProxy = () => {
        closePromise ??= authProxy.close();
        return closePromise;
      };
      const authProxyPort = authProxy.port;
      authProxyClose = closeAuthProxy;
      pending.closeAuthProxy = closeAuthProxy;
      if (this.pendingTunnels.get(workspaceId) !== pending) {
        await closeAuthProxy();
        return null;
      }
      const tunnel = await startCloudflaredTunnel({
        targetUrl: `http://${LOCAL_HOST}:${authProxyPort}`,
      });
      cloudflaredProcess = tunnel.proc;
      if (this.pendingTunnels.get(workspaceId) !== pending) {
        await Promise.allSettled([killProcessWithTimeout(cloudflaredProcess), closeAuthProxy()]);
        return null;
      }

      const authenticatedUrl = `${tunnel.publicUrl}?${TOKEN_QUERY_PARAM}=${authToken}`;
      const activeTunnel: ActiveTunnel = {
        upstreamPort,
        publicUrl: tunnel.publicUrl,
        authenticatedUrl,
        cloudflaredProcess,
        closeAuthProxy,
        leases: 0,
        disposed: false,
      };
      this.tunnels.set(workspaceId, activeTunnel);
      if (!this.watchTunnelExit(workspaceId, activeTunnel)) {
        return null;
      }

      logger.info('Started run-script proxy tunnel', {
        workspaceId,
        upstreamPort,
        publicUrl: tunnel.publicUrl,
      });

      return this.createLease(workspaceId, activeTunnel);
    } catch (error) {
      if (isCommandNotFoundError(error)) {
        this.cloudflaredUnavailable = true;
      }

      logger.warn('Failed to start run-script proxy tunnel', {
        workspaceId,
        upstreamPort,
        error: error instanceof Error ? error.message : String(error),
      });

      await Promise.allSettled([
        ...(cloudflaredProcess ? [killProcessWithTimeout(cloudflaredProcess)] : []),
        ...(authProxyClose ? [authProxyClose()] : []),
      ]);

      return null;
    }
  }

  private disposeTunnel(workspaceId: string, tunnel: ActiveTunnel): Promise<void> {
    if (tunnel.disposed) {
      return tunnel.disposal ?? Promise.resolve();
    }
    tunnel.disposed = true;

    if (this.tunnels.get(workspaceId) === tunnel) {
      this.tunnels.delete(workspaceId);
    }
    tunnel.disposal = Promise.allSettled([
      killProcessWithTimeout(tunnel.cloudflaredProcess),
      tunnel.closeAuthProxy(),
    ]).then(() => {
      logger.info('Stopped run-script proxy tunnel', {
        workspaceId,
        upstreamPort: tunnel.upstreamPort,
        publicUrl: tunnel.publicUrl,
      });
    });
    return tunnel.disposal;
  }

  async stopTunnel(workspaceId: string): Promise<void> {
    const pending = this.pendingTunnels.get(workspaceId);
    this.pendingTunnels.delete(workspaceId);
    const existing = this.tunnels.get(workspaceId);
    await Promise.allSettled([
      ...(existing ? [this.disposeTunnel(workspaceId, existing)] : []),
      ...(pending?.closeAuthProxy ? [pending.closeAuthProxy()] : []),
    ]);
  }

  async cleanup(): Promise<void> {
    const workspaceIds = new Set([...this.pendingTunnels.keys(), ...this.tunnels.keys()]);
    await Promise.all(Array.from(workspaceIds, (workspaceId) => this.stopTunnel(workspaceId)));
  }

  cleanupSync(): void {
    for (const pending of this.pendingTunnels.values()) {
      void pending.closeAuthProxy?.().catch(() => undefined);
    }
    this.pendingTunnels.clear();
    for (const [workspaceId, tunnel] of this.tunnels.entries()) {
      this.tunnels.delete(workspaceId);
      tunnel.disposed = true;

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
