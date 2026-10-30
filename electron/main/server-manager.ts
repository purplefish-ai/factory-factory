import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { app, utilityProcess } from 'electron';
import { z } from 'zod';

/** Startup includes migrations and startup reconciliation, which can be slow on large databases. */
const DEFAULT_START_TIMEOUT_MS = 120_000;
/**
 * Graceful stop plus the force-kill wait stays under the 30-second fatal-error
 * deadline in fatal-error-handlers.ts, so a stalled backend is killed before
 * the app quits.
 */
const DEFAULT_STOP_TIMEOUT_MS = 25_000;
const FORCE_KILL_WAIT_MS = 3000;

// Keep in sync with src/backend/electron-utility-backend.ts.
const BackendMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), url: z.string().min(1) }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export interface BackendChildProcess {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  postMessage(message: { type: 'shutdown' }): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(
    event: 'error',
    listener: (type: 'FatalError', location: string, report: string) => void
  ): this;
  off(event: 'message', listener: (message: unknown) => void): this;
  off(event: 'exit', listener: (code: number) => void): this;
}

export interface UtilityProcessFactory {
  fork(
    modulePath: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv;
      stdio: 'pipe';
      serviceName: string;
    }
  ): BackendChildProcess;
}

interface ServerManagerLogger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface BackendExitDetails {
  code: number;
}

export interface ServerManagerOptions {
  utilityProcess?: UtilityProcessFactory;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  logger?: ServerManagerLogger;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

interface BackendProcess {
  child: BackendChildProcess;
  url: string | null;
  stopping: boolean;
  exitCode: number | null;
  exited: Promise<number>;
}

const TIMED_OUT = Symbol('timed-out');

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timeout = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

/**
 * ServerManager runs the backend in an Electron utility process, so backend
 * stalls (synchronous SQLite, agent streams, terminals) cannot freeze the
 * window. The utility process uses Electron's Node runtime, so native modules
 * built for Electron load there too.
 */
export class ServerManager {
  private backend: BackendProcess | null = null;
  private lifecycleLock: Promise<void> = Promise.resolve();
  private readonly exitListeners = new Set<(details: BackendExitDetails) => void>();
  private readonly utilityProcess: UtilityProcessFactory;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly logger: ServerManagerLogger;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;

  constructor(options: ServerManagerOptions = {}) {
    this.utilityProcess = options.utilityProcess ?? utilityProcess;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.logger = options.logger ?? console;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  /**
   * Start the backend server.
   * - In dev mode with Vite, returns Vite dev server URL
   * - In production, forks the backend utility process
   *
   * @returns The URL to load in the browser window
   */
  start(): Promise<string> {
    // In dev mode, use Vite dev server URL (includes HMR)
    const viteDevUrl = process.env.VITE_DEV_SERVER_URL;
    if (viteDevUrl) {
      this.logger.log(`[electron] Dev mode: using Vite dev server at ${viteDevUrl}`);
      return Promise.resolve(viteDevUrl);
    }

    return this.withLifecycleLock(async () => {
      if (this.backend?.url) {
        return this.backend.url;
      }

      const backend = this.forkBackend();
      try {
        const url = await this.waitForReady(backend);
        backend.url = url;
        this.logger.log(`[electron] Backend server started at ${url}`);
        return url;
      } catch (error) {
        await this.forceStop(backend);
        throw error;
      }
    });
  }

  /**
   * Stop the backend server gracefully: ask it to shut down, then force-kill
   * it if it has not exited within the stop timeout.
   */
  async stop(): Promise<void> {
    // A start in flight holds the lock for up to the start timeout. Cancel it
    // now so quitting during startup does not wait for the backend to be ready.
    this.cancelPendingStart();

    await this.withLifecycleLock(async () => {
      const backend = this.backend;
      if (!backend) {
        return;
      }

      this.logger.log('[electron] Stopping backend server...');
      backend.stopping = true;
      this.requestShutdown(backend);

      const code = await waitWithTimeout(backend.exited, this.stopTimeoutMs);
      if (code === TIMED_OUT) {
        await this.forceStop(backend);
        throw new Error(`Backend did not exit within ${this.stopTimeoutMs}ms and was killed`);
      }
      this.clearBackend(backend);
      if (code !== 0) {
        throw new Error(`Backend exited with code ${code} during shutdown`);
      }
      this.logger.log('[electron] Backend server stopped');
    });
  }

  private cancelPendingStart(): void {
    const backend = this.backend;
    if (!backend || backend.url !== null || backend.stopping) {
      return;
    }
    this.logger.log('[electron] Cancelling backend startup...');
    backend.stopping = true;
    this.requestShutdown(backend);
    // The backend handles shutdown between startup steps; kill it if a step
    // (such as a long migration) keeps it from exiting in time.
    void waitWithTimeout(backend.exited, this.stopTimeoutMs).then((result) => {
      if (result === TIMED_OUT) {
        void this.forceStop(backend);
      }
    });
  }

  private requestShutdown(backend: BackendProcess): void {
    if (backend.exitCode !== null) {
      return;
    }
    try {
      backend.child.postMessage({ type: 'shutdown' });
    } catch (error) {
      this.logger.error('[electron] Failed to send shutdown to backend:', error);
    }
  }

  /** Called when a started backend exits without being asked to stop. */
  onUnexpectedExit(listener: (details: BackendExitDetails) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  private forkBackend(): BackendProcess {
    const userDataPath = app.getPath('userData');
    const databasePath = join(userDataPath, 'data.db');
    this.ensureDataDir(databasePath);

    // - Migrations are in Resources/prisma/migrations (via extraResources)
    // - Backend and frontend are unpacked from the asar archive
    const unpackedDist = join(process.resourcesPath, 'app.asar.unpacked', 'dist');
    const migrationsPath = join(process.resourcesPath, 'prisma', 'migrations');
    const frontendDist = join(unpackedDist, 'client');
    const wsLogsPath = join(userDataPath, 'ws-logs');
    const entryPath = join(unpackedDist, 'src', 'backend', 'electron-utility-entry.js');

    this.logger.log('[electron] Configuration:');
    this.logger.log(`[electron]   Database: ${databasePath}`);
    this.logger.log(`[electron]   Frontend: ${frontendDist}`);
    this.logger.log(`[electron]   Migrations: ${migrationsPath}`);
    this.logger.log(`[electron]   WS Logs: ${wsLogsPath}`);
    this.logger.log('[electron] Starting backend utility process...');

    const child = this.utilityProcess.fork(entryPath, [], {
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        MIGRATIONS_PATH: migrationsPath,
        FRONTEND_STATIC_PATH: frontendDist,
        WS_LOGS_PATH: wsLogsPath,
        NODE_ENV: 'production',
        // On macOS a utility process runs from the Electron Helper binary. The
        // backend launches bundled Node entrypoints with the main app binary.
        FF_NODE_EXEC_PATH: process.execPath,
      },
      stdio: 'pipe',
      serviceName: 'Factory Factory Backend',
    });

    let resolveExited!: (code: number) => void;
    const backend: BackendProcess = {
      child,
      url: null,
      stopping: false,
      exitCode: null,
      exited: new Promise<number>((resolve) => {
        resolveExited = resolve;
      }),
    };
    this.backend = backend;

    this.forwardOutput(child.stdout, (line) => this.logger.log(`[backend] ${line}`));
    this.forwardOutput(child.stderr, (line) => this.logger.error(`[backend] ${line}`));
    child.on('error', (type, location, report) => {
      this.logger.error(`[electron] Backend ${type} at ${location}:`, report);
    });
    child.on('exit', (code) => {
      backend.exitCode = code;
      this.clearBackend(backend);
      resolveExited(code);
      if (backend.url !== null && !backend.stopping) {
        this.logger.error(`[electron] Backend exited unexpectedly with code ${code}`);
        for (const listener of this.exitListeners) {
          listener({ code });
        }
      }
    });

    return backend;
  }

  private waitForReady(backend: BackendProcess): Promise<string> {
    const { child } = backend;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, url?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.off('message', onMessage);
        child.off('exit', onExit);
        if (error) {
          reject(error);
        } else if (url) {
          resolve(url);
        }
      };
      const onMessage = (message: unknown) => {
        const parsed = BackendMessageSchema.safeParse(message);
        if (!parsed.success) {
          this.logger.error('[electron] Ignoring unknown backend message:', message);
          return;
        }
        if (parsed.data.type === 'ready') {
          if (backend.stopping) {
            // A stop cancelled this start and the backend is shutting down; its
            // exit rejects the start instead of handing out a dying backend's URL.
            this.logger.log('[electron] Ignoring ready from a backend that is stopping');
            return;
          }
          finish(null, parsed.data.url);
        } else {
          finish(new Error(`Backend failed to start:\n\n${parsed.data.message}`));
        }
      };
      const onExit = (code: number) => {
        finish(
          new Error(
            backend.stopping
              ? 'Backend startup was cancelled by a stop request'
              : `Backend exited with code ${code} before it was ready`
          )
        );
      };
      const timeout = setTimeout(() => {
        finish(new Error(`Backend did not start within ${this.startTimeoutMs}ms`));
      }, this.startTimeoutMs);

      child.on('message', onMessage);
      child.on('exit', onExit);
    });
  }

  /** Kill a backend that failed to start or to stop, and wait briefly for its exit. */
  private async forceStop(backend: BackendProcess): Promise<void> {
    backend.stopping = true;
    if (backend.exitCode === null) {
      const { pid } = backend.child;
      try {
        if (pid === undefined) {
          backend.child.kill();
        } else {
          // kill() sends SIGTERM, which the backend treats as a graceful stop.
          this.killProcess(pid, 'SIGKILL');
        }
      } catch (error) {
        this.logger.error('[electron] Failed to kill backend process:', error);
      }
      if ((await waitWithTimeout(backend.exited, FORCE_KILL_WAIT_MS)) === TIMED_OUT) {
        this.logger.error('[electron] Backend did not exit after being killed');
      }
    }
    this.clearBackend(backend);
  }

  private clearBackend(backend: BackendProcess): void {
    if (this.backend === backend) {
      this.backend = null;
    }
  }

  private forwardOutput(stream: NodeJS.ReadableStream | null, write: (line: string) => void): void {
    if (!stream) {
      return;
    }
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', write);
  }

  /**
   * Ensure the directory for the database file exists.
   */
  private ensureDataDir(databasePath: string): void {
    const dir = dirname(databasePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private async withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const pendingOperation = this.lifecycleLock;
    let releaseCurrentOperation!: () => void;
    this.lifecycleLock = new Promise<void>((resolve) => {
      releaseCurrentOperation = resolve;
    });

    await pendingOperation;

    try {
      return await operation();
    } finally {
      releaseCurrentOperation();
    }
  }
}
