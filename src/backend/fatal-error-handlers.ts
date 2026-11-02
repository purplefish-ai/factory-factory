const FATAL_SHUTDOWN_TIMEOUT_MS = 30_000;

interface FatalErrorLogger {
  error(message: string, errorInfo: unknown): void;
  fatal?(message: string, errorInfo: unknown): void;
}

interface FatalErrorProcess {
  on(event: 'uncaughtException', listener: (error: Error) => void | Promise<void>): this;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void | Promise<void>): this;
  exit(code: number): void;
}

interface FatalErrorServer {
  stop(): Promise<void>;
}

interface FatalErrorHandlerDependencies {
  logger: FatalErrorLogger;
  process: FatalErrorProcess;
  server: FatalErrorServer;
}

export function registerFatalErrorHandlers({
  logger,
  process,
  server,
}: FatalErrorHandlerDependencies): void {
  let isShuttingDown = false;

  const shutdown = async (message: string, errorInfo: unknown): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    // Claim ownership before touching a sink: logging itself can reenter here.
    isShuttingDown = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      try {
        if (logger.fatal) {
          logger.fatal(message, errorInfo);
        } else {
          logger.error(message, errorInfo);
        }
      } catch {
        // A failed log sink must not prevent cleanup or cause another fatal log.
      }
      await Promise.race([
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, FATAL_SHUTDOWN_TIMEOUT_MS);
        }),
        server.stop(),
      ]);
    } catch {
      // Ignore cleanup errors; the original fatal record is already written.
    } finally {
      clearTimeout(timeout);
      process.exit(1);
    }
  };

  process.on('uncaughtException', async (error) => {
    await shutdown('Uncaught exception', error);
  });

  process.on('unhandledRejection', async (reason) => {
    if (isShuttingDown) {
      return;
    }
    let errorInfo: Record<string, unknown>;
    if (reason instanceof Error) {
      errorInfo = { message: reason.message, stack: reason.stack, name: reason.name };
    } else {
      let stringifiedReason = '[unstringifiable rejection reason]';
      try {
        stringifiedReason = String(reason);
      } catch {
        // Keep the fatal path reliable even when the rejection reason cannot be coerced.
      }
      errorInfo = { reason: stringifiedReason };
    }

    await shutdown('Unhandled rejection at promise', errorInfo);
  });
}
