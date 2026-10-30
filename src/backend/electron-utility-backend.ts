/**
 * Desktop backend lifecycle inside an Electron utility process.
 *
 * Electron main forks `electron-utility-entry.ts` and talks to it over
 * `process.parentPort`:
 * - child → main: `{ type: 'ready', url }` once the server listens, or
 *   `{ type: 'error', message }` when migrations or startup fail.
 * - main → child: `{ type: 'shutdown' }` to stop gracefully and exit.
 *
 * Keep these shapes in sync with `electron/main/server-manager.ts`.
 */

import { z } from 'zod';
import { registerFatalErrorHandlers } from './fatal-error-handlers';
import { toError } from './lib/error-utils';
import { registerShutdownSignalHandlers } from './shutdown-signal-handlers';

const ParentMessageSchema = z.object({ type: z.literal('shutdown') });

export type UtilityBackendMessage =
  | { type: 'ready'; url: string }
  | { type: 'error'; message: string };

export interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: UtilityBackendMessage): void;
}

interface UtilityProcessLike {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): this;
  on(event: 'uncaughtException', listener: (error: Error) => void | Promise<void>): this;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void | Promise<void>): this;
  exit(code: number): void;
}

interface BackendServer {
  start(): Promise<string>;
  stop(): Promise<void>;
}

interface UtilityBackendLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error: unknown): void;
}

export interface ElectronUtilityBackendDependencies {
  parentPort: ParentPortLike;
  process: UtilityProcessLike;
  logger: UtilityBackendLogger;
  /** Applies pending SQLite migrations before any backend module opens the database. */
  migrate(): void;
  /** Composes the application and server, and registers the server instance. */
  createServer(): Promise<BackendServer>;
}

function describeError(error: unknown): string {
  const normalized = toError(error);
  return normalized.stack ?? normalized.message;
}

export async function runElectronUtilityBackend({
  parentPort,
  process,
  logger,
  migrate,
  createServer,
}: ElectronUtilityBackendDependencies): Promise<void> {
  let server: BackendServer | null = null;
  let shutdownRequested = false;

  // Handlers see the server once it exists; before that there is nothing to stop.
  const lazyServer = {
    stop: (): Promise<void> => server?.stop() ?? Promise.resolve(),
  };
  registerShutdownSignalHandlers({ logger, process, server: lazyServer });
  registerFatalErrorHandlers({ logger, process, server: lazyServer });

  parentPort.on('message', (event) => {
    if (!ParentMessageSchema.safeParse(event.data).success) {
      logger.warn('Ignoring unknown message from Electron main');
      return;
    }
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    logger.info('Shutdown requested by Electron main');
    void lazyServer.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('Failed to shut down server', toError(error));
        process.exit(1);
      }
    );
  });

  try {
    migrate();
    server = await createServer();
    const url = await server.start();
    if (shutdownRequested) {
      return;
    }
    parentPort.postMessage({ type: 'ready', url });
  } catch (error) {
    if (shutdownRequested) {
      // Stopping during startup makes start() fail; the shutdown path exits.
      return;
    }
    logger.error('Failed to start backend', toError(error));
    parentPort.postMessage({ type: 'error', message: describeError(error) });
    process.exit(1);
  }
}
