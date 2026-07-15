interface FatalErrorLogger {
  error(message: string, errorInfo: unknown): void;
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

  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    try {
      await server.stop();
    } catch {
      // Ignore cleanup errors
    }
    process.exit(1);
  };

  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught exception', error);
    await shutdown();
  });

  process.on('unhandledRejection', async (reason) => {
    const errorInfo =
      reason instanceof Error
        ? { message: reason.message, stack: reason.stack, name: reason.name }
        : { reason: String(reason) };

    logger.error('Unhandled rejection at promise', errorInfo);
    await shutdown();
  });
}
