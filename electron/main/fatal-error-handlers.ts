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
  on(event: 'uncaughtException', listener: (error: Error) => void): this;
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
    try {
      await serverManager.stop();
    } catch (error) {
      logger.error('[electron] Failed to stop backend after fatal error:', error);
    } finally {
      app.quit();
    }
  };

  process.on('uncaughtException', (error) => {
    logger.error('[electron] Uncaught exception:', error);
    dialog.showErrorBox('Uncaught Exception', error.stack || String(error));
    void shutdown();
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[electron] Unhandled rejection:', reason);
    dialog.showErrorBox('Unhandled Rejection', String(reason));
    void shutdown();
  });
}
