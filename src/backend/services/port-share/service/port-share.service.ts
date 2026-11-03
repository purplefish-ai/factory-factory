import { type ChildProcess, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { terminateDisposableProcessTree } from '@/backend/lib/owned-process-cleanup';
import { isServePortConfigured, readTailscale } from '@/backend/lib/tailscale-cli';
import { configService, type TailscaleConfig } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import { serverInstanceService } from '@/backend/services/server-instance.service';
import { appendBoundedOutputBuffer } from '@/shared/proxy-utils';
import { type PortForwarder, startPortForwarder } from './port-forwarder';
import { getPortRefusal, type PortRefusal } from './port-policy';
import { ShareRecordStore } from './share-records';

const logger = createLogger('port-share-service');

const PROBE_TIMEOUT_MS = 1000;
const SERVE_READY_TIMEOUT_MS = 8000;
const SERVE_READY_POLL_MS = 100;
const SERVE_STOP_TIMEOUT_MS = 3000;
const healthSchema = z.object({ service: z.literal('factoryfactory-backend') });

export type PortShareFailure =
  | 'DISABLED'
  | PortRefusal
  | 'NOT_LISTENING'
  | 'PORT_IN_USE'
  | 'SERVE_FAILED';

export class PortShareError extends ApplicationError {
  constructor(
    public readonly reason: PortShareFailure,
    message: string
  ) {
    super('PRECONDITION_FAILED', message);
    this.name = 'PortShareError';
  }
}

interface ActiveShare {
  port: number;
  url: string;
  forwarder: PortForwarder;
  serve: ChildProcess;
}

export interface PortShareServiceOptions {
  getTailscaleConfig?: () => TailscaleConfig | null;
  getBackendPort?: () => number | null;
  records?: ShareRecordStore;
  tailscaleCommand?: string;
  readyTimeoutMs?: number;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Another Factory Factory backend must never become reachable through a share. */
function isFactoryFactoryBackend(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host, port, path: '/health', method: 'GET', timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 16_384) {
            res.destroy();
          }
        });
        res.once('end', () => {
          try {
            resolve(healthSchema.safeParse(JSON.parse(body)).success);
          } catch {
            resolve(false);
          }
        });
        res.once('error', () => resolve(false));
      }
    );
    req.once('timeout', () => req.destroy());
    req.once('error', () => resolve(false));
    req.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shares loopback ports on this machine's Tailscale name. Each share is a
 * forwarder in this process plus a foreground `tailscale serve` child; both
 * live until the backend stops. A crash leaves only Serve listeners pointing
 * at a closed forwarder, which the next start stops via {@link ShareRecordStore}.
 */
export class PortShareService {
  private readonly shares = new Map<number, ActiveShare>();
  private readonly pending = new Map<number, Promise<string>>();
  private stopping = false;
  private readonly getTailscaleConfig: () => TailscaleConfig | null;
  private readonly getBackendPort: () => number | null;
  private recordStore: ShareRecordStore | undefined;
  private readonly tailscaleCommand: string;
  private readonly readyTimeoutMs: number;

  constructor(options: PortShareServiceOptions = {}) {
    this.getTailscaleConfig =
      options.getTailscaleConfig ?? (() => configService.getTailscaleConfig());
    this.getBackendPort = options.getBackendPort ?? (() => serverInstanceService.getPort());
    this.recordStore = options.records;
    this.tailscaleCommand = options.tailscaleCommand ?? 'tailscale';
    this.readyTimeoutMs = options.readyTimeoutMs ?? SERVE_READY_TIMEOUT_MS;
  }

  private get records(): ShareRecordStore {
    this.recordStore ??= new ShareRecordStore(join(configService.getBaseDir(), 'port-shares'));
    return this.recordStore;
  }

  isAvailable(): boolean {
    return this.getTailscaleConfig() !== null;
  }

  /** Public origin a port is (or would be) shared on, without sharing it. */
  getShareOrigin(port: number): string | null {
    const config = this.getTailscaleConfig();
    return config ? `https://${config.hostname}:${port}` : null;
  }

  listSharedPorts(): number[] {
    return [...this.shares.keys()].sort((a, b) => a - b);
  }

  /** Shares `port` if needed and returns its public origin. */
  ensure(port: number): Promise<string> {
    const config = this.getTailscaleConfig();
    if (!config || this.stopping) {
      return Promise.reject(
        new PortShareError('DISABLED', 'Port sharing is available only through ff tailscale.')
      );
    }
    const refusal = getPortRefusal(port, [this.getBackendPort(), config.httpsPort]);
    if (refusal) {
      return Promise.reject(new PortShareError(refusal, refusalMessage(refusal, port)));
    }
    const existing = this.shares.get(port);
    if (existing) {
      return Promise.resolve(existing.url);
    }
    let pending = this.pending.get(port);
    if (!pending) {
      pending = this.create(port, config).finally(() => {
        this.pending.delete(port);
      });
      this.pending.set(port, pending);
    }
    return pending;
  }

  private async create(port: number, config: TailscaleConfig): Promise<string> {
    const upstreamHost = (await canConnect('127.0.0.1', port))
      ? '127.0.0.1'
      : (await canConnect('::1', port))
        ? '::1'
        : null;
    if (!upstreamHost) {
      throw new PortShareError(
        'NOT_LISTENING',
        `Nothing is listening on port ${port} on the host. Start it, then try again.`
      );
    }
    if (await isFactoryFactoryBackend(upstreamHost, port)) {
      throw new PortShareError('FACTORY_FACTORY', refusalMessage('FACTORY_FACTORY', port));
    }
    if (await this.isServePortInUse(port)) {
      throw new PortShareError(
        'PORT_IN_USE',
        `Tailscale port ${port} already has another Serve or Funnel configuration.`
      );
    }

    const url = `https://${config.hostname}:${port}`;
    const forwarder = await startPortForwarder({
      upstreamHost,
      upstreamPort: port,
      publicOrigin: url,
    });
    let serve: ChildProcess | undefined;
    try {
      serve = spawn(
        this.tailscaleCommand,
        ['serve', `--https=${port}`, `http://127.0.0.1:${forwarder.port}`],
        // A detached group lets cleanup stop the macOS CLI wrapper and the real
        // binary it launches together; stopping only the wrapper leaves the share.
        { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      await this.waitForServe(port, serve);
      if (this.stopping) {
        throw new PortShareError('DISABLED', 'Factory Factory is shutting down.');
      }
    } catch (error) {
      if (serve) {
        await this.stopServe(serve);
      }
      await forwarder.close();
      throw error;
    }

    const share: ActiveShare = { port, url, forwarder, serve };
    this.shares.set(port, share);
    serve.once('exit', () => {
      if (this.shares.get(port) === share) {
        logger.warn('Tailscale Serve exited; closing port share', { port });
        this.shares.delete(port);
        void forwarder.close();
        void this.persist();
      }
    });
    await this.persist();
    logger.info('Shared port through Tailscale', { port, url });
    return url;
  }

  private async isServePortInUse(port: number): Promise<boolean> {
    try {
      return isServePortConfigured(
        await readTailscale(['serve', 'status', '--json'], undefined, this.tailscaleCommand),
        port
      );
    } catch (error) {
      throw new PortShareError(
        'SERVE_FAILED',
        error instanceof Error ? error.message : 'Could not read Tailscale Serve status.'
      );
    }
  }

  private async waitForServe(port: number, serve: ChildProcess): Promise<void> {
    let output = '';
    const collect = (chunk: Buffer) => {
      output = appendBoundedOutputBuffer(output, chunk.toString(), 2000);
    };
    serve.stdout?.on('data', collect);
    serve.stderr?.on('data', collect);
    let spawnError: Error | undefined;
    serve.once('error', (error) => {
      spawnError = error;
    });
    const failed = () =>
      new PortShareError(
        'SERVE_FAILED',
        `Tailscale could not share port ${port}.${output.trim() ? ` ${output.trim()}` : ''}`
      );
    const deadline = Date.now() + this.readyTimeoutMs;
    try {
      while (Date.now() < deadline) {
        if (spawnError || serve.exitCode !== null || serve.signalCode !== null) {
          throw failed();
        }
        if (await this.isServePortInUse(port)) {
          return;
        }
        await delay(SERVE_READY_POLL_MS);
      }
      throw failed();
    } finally {
      serve.stdout?.off('data', collect);
      serve.stderr?.off('data', collect);
      serve.stdout?.resume();
      serve.stderr?.resume();
    }
  }

  private async stopServe(serve: ChildProcess): Promise<void> {
    try {
      await terminateDisposableProcessTree(serve, { timeoutMs: SERVE_STOP_TIMEOUT_MS });
    } catch (error) {
      logger.warn('Failed to stop Tailscale Serve', {
        pid: serve.pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async persist(): Promise<void> {
    const shares = [...this.shares.values()].flatMap((share) =>
      share.serve.pid
        ? [{ pgid: share.serve.pid, httpsPort: share.port, forwarderPort: share.forwarder.port }]
        : []
    );
    try {
      await this.records.write(shares);
    } catch (error) {
      logger.warn('Failed to record port shares', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Stops Serve listeners a crashed backend left behind. */
  async stopStaleShares(): Promise<void> {
    try {
      const stopped = await this.records.stopStaleShares();
      if (stopped > 0) {
        logger.info('Stopped stale Tailscale port shares', { stopped });
      }
    } catch (error) {
      logger.warn('Failed to stop stale Tailscale port shares', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Stops every share: Serve first, so no listener outlives its forwarder. */
  async cleanup(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.pending.values());
    const shares = [...this.shares.values()];
    this.shares.clear();
    await Promise.all(
      shares.map(async (share) => {
        await this.stopServe(share.serve);
        await share.forwarder.close();
      })
    );
    await this.persist();
  }
}

function refusalMessage(refusal: PortRefusal, port: number): string {
  switch (refusal) {
    case 'PRIVILEGED':
      return `Port ${port} is a system port; only ports 1024 and above can be shared.`;
    case 'FACTORY_FACTORY':
      return `Port ${port} is a Factory Factory server and cannot be shared.`;
    case 'SERVICE':
      return `Port ${port} is a database or infrastructure port and cannot be shared.`;
  }
}

export const portShareService = new PortShareService();
