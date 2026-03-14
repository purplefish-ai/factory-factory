import type {
  BrowserWindowConstructorOptions,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from 'electron';

interface AppLike {
  on(event: 'activate' | 'window-all-closed', listener: () => void): void;
  whenReady(): Promise<void>;
  quit(): void;
}

interface BrowserWindowLike {
  loadURL(url: string): Promise<void>;
  on(event: 'focus' | 'blur' | 'closed', listener: () => void): void;
  webContents: {
    send(channel: string, focused: boolean): void;
  };
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
}

interface BrowserWindowConstructorLike {
  new (options: BrowserWindowConstructorOptions): BrowserWindowLike;
  getAllWindows(): BrowserWindowLike[];
}

interface DialogLike {
  showErrorBox(title: string, content: string): void;
  showOpenDialog(window: unknown, options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
}

interface IpcMainLike {
  handle(
    channel: string,
    listener: (_event: unknown, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>
  ): void;
}

interface ServerManagerLike {
  start(): Promise<string>;
  stop(): Promise<void>;
}

interface LoggerLike {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ElectronLifecycleDependencies {
  app: AppLike;
  browserWindow: BrowserWindowConstructorLike;
  dialog: DialogLike;
  ipcMain: IpcMainLike;
  logger: LoggerLike;
  platform: NodeJS.Platform;
  preloadPath: string;
  serverManager: ServerManagerLike;
}

export interface ElectronLifecycleController {
  registerIpcHandlers(): void;
  registerAppHandlers(): void;
  start(): void;
  createWindow(): Promise<BrowserWindowLike | null>;
  handleActivate(): Promise<void>;
  handleWindowAllClosed(): void;
}

export function createElectronLifecycle({
  app,
  browserWindow,
  dialog,
  ipcMain,
  logger,
  platform,
  preloadPath,
  serverManager,
}: ElectronLifecycleDependencies): ElectronLifecycleController {
  let mainWindow: BrowserWindowLike | null = null;
  let createWindowPromise: Promise<BrowserWindowLike | null> | null = null;
  let stopServerPromise: Promise<void> | null = null;

  const resolveMainWindow = (): BrowserWindowLike | null => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      return mainWindow;
    }

    const [existingWindow] = browserWindow.getAllWindows();
    if (existingWindow && !existingWindow.isDestroyed()) {
      mainWindow = existingWindow;
      return existingWindow;
    }

    mainWindow = null;
    return null;
  };

  const stopServer = (): Promise<void> => {
    if (stopServerPromise !== null) {
      return stopServerPromise;
    }

    stopServerPromise = serverManager
      .stop()
      .catch((error) => {
        logger.error('[electron] Failed to stop backend server:', error);
      })
      .finally(() => {
        stopServerPromise = null;
      });

    return stopServerPromise;
  };

  const createWindow = (): Promise<BrowserWindowLike | null> => {
    const existingWindow = resolveMainWindow();
    if (existingWindow) {
      existingWindow.show();
      existingWindow.focus();
      return Promise.resolve(existingWindow);
    }

    if (createWindowPromise !== null) {
      return createWindowPromise;
    }

    createWindowPromise = (async () => {
      try {
        logger.log('[electron] Starting createWindow...');
        logger.log('[electron] process.resourcesPath:', process.resourcesPath);
        logger.log('[electron] process.cwd():', process.cwd());

        if (stopServerPromise !== null) {
          await stopServerPromise;
        }

        const url = await serverManager.start();
        logger.log('[electron] Server started, URL:', url);

        const window = new browserWindow({
          width: 1400,
          height: 900,
          webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        mainWindow = window;

        window.on('focus', () => {
          window.webContents.send('window-focus-changed', true);
        });

        window.on('blur', () => {
          window.webContents.send('window-focus-changed', false);
        });

        window.on('closed', () => {
          if (mainWindow === window) {
            mainWindow = null;
          }
        });

        await window.loadURL(url);
        logger.log('[electron] Window created and URL loaded');
        return window;
      } catch (error) {
        logger.error('[electron] Failed to create window:', error);
        dialog.showErrorBox(
          'Startup Error',
          `Failed to start application:\n\n${error instanceof Error ? error.stack : String(error)}`
        );
        app.quit();
        return null;
      } finally {
        createWindowPromise = null;
      }
    })();

    return createWindowPromise;
  };

  const handleActivate = async (): Promise<void> => {
    if (browserWindow.getAllWindows().length > 0) {
      return;
    }

    await createWindow();
  };

  const handleWindowAllClosed = (): void => {
    const stopPromise = stopServer();

    if (platform !== 'darwin') {
      void stopPromise.finally(() => {
        app.quit();
      });
    }
  };

  const registerIpcHandlers = (): void => {
    ipcMain.handle('dialog:showOpen', (_event, options) => {
      const currentWindow = resolveMainWindow();
      if (!currentWindow) {
        return Promise.resolve({ canceled: true, filePaths: [] });
      }

      return dialog.showOpenDialog(currentWindow, options);
    });
  };

  const registerAppHandlers = (): void => {
    app.on('activate', () => {
      void handleActivate();
    });

    app.on('window-all-closed', () => {
      handleWindowAllClosed();
    });
  };

  const start = (): void => {
    logger.log('[electron] App starting, waiting for ready...');

    void app
      .whenReady()
      .then(async () => {
        logger.log('[electron] App ready, creating window...');
        await createWindow();
      })
      .catch((error) => {
        logger.error('[electron] Fatal error during startup:', error);
        dialog.showErrorBox(
          'Fatal Startup Error',
          `Application failed to start:\n\n${error instanceof Error ? error.stack : String(error)}`
        );
        app.quit();
      });
  };

  return {
    registerIpcHandlers,
    registerAppHandlers,
    start,
    createWindow,
    handleActivate,
    handleWindowAllClosed,
  };
}

export type { BrowserWindowLike as ElectronLifecycleBrowserWindow };
