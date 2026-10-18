import { toError } from './lib/error-utils';

interface ShutdownDependencies {
  process: {
    on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
    exit(code: number): void;
  };
  logger: {
    info(message: string): void;
    error(message: string, error: unknown): void;
  };
  server: { stop(): Promise<void> };
}

export function registerShutdownSignalHandlers({
  process,
  logger,
  server,
}: ShutdownDependencies): void {
  let shuttingDown = false;
  const shutdown = (signal: 'SIGTERM' | 'SIGINT'): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully`);
    void server.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('Failed to shut down server', toError(error));
        process.exit(1);
      }
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
