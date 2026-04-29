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
}: FatalErrorHandlerDependencies): void {
  process.on('uncaughtException', (error) => {
    logger.error('[electron] Uncaught exception:', error);
    dialog.showErrorBox('Uncaught Exception', error.stack || String(error));
    app.quit();
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[electron] Unhandled rejection:', reason);
    dialog.showErrorBox('Unhandled Rejection', String(reason));
    app.quit();
  });
}
