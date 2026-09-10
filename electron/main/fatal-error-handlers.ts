const FATAL_SHUTDOWN_TIMEOUT_MS = 30_000;

interface FatalErrorApp {
  quit(): void;
}

interface FatalErrorDialog {
  showErrorBox(title: string, content: string): void;
}

interface FatalErrorLogger {
  error(message?: unknown, ...optionalParams: unknown[]): void;
}

interface FatalErrorProcess {
  on(event: 'uncaughtException', listener: (error: unknown) => void): this;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): this;
}

interface FatalErrorHandlerDependencies {
  serverManager: { stop(): Promise<void> };
  app: FatalErrorApp;
  dialog: FatalErrorDialog;
  logger: FatalErrorLogger;
  process: FatalErrorProcess;
}

export function registerFatalErrorHandlers({
  app,
  dialog,
  logger,
  process,
  serverManager,
}: FatalErrorHandlerDependencies): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        serverManager.stop(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Backend shutdown timed out after ${FATAL_SHUTDOWN_TIMEOUT_MS}ms`));
          }, FATAL_SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      logger.error('[electron] Failed to stop backend after fatal error:', error);
    } finally {
      clearTimeout(timeout);
      app.quit();
    }
  };

  process.on('uncaughtException', (error) => {
    logger.error('[electron] Uncaught exception:', error);
    dialog.showErrorBox(
      'Uncaught Exception',
      error instanceof Error ? error.stack || String(error) : String(error)
    );
    void shutdown();
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[electron] Unhandled rejection:', reason);
    dialog.showErrorBox(
      'Unhandled Rejection',
      reason instanceof Error ? reason.stack || String(reason) : String(reason)
    );
    void shutdown();
  });
}
