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

// Opaque marker compared by reference only, to check an IPC call's sender
// frame against the trusted app window without depending on Electron's
// WebFrameMain type.
type WebFrameLike = object;

interface BrowserWindowLike {
  loadURL(url: string): Promise<void>;
  on(event: 'focus' | 'blur' | 'closed', listener: () => void): void;
  webContents: {
    send(channel: string, focused: boolean): void;
    mainFrame: WebFrameLike;
  };
  destroy(): void;
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

interface NativeImageLike {
  isEmpty(): boolean;
  toPNG(): Uint8Array;
}

interface ClipboardLike {
  readImage(): NativeImageLike;
}

interface IpcMainInvokeEventLike {
  senderFrame: WebFrameLike | null;
}

interface IpcMainLike {
  handle<Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEventLike, ...args: Args) => Result
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
  clipboard: ClipboardLike;
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

// Mirrors MAX_IMAGE_SIZE in src/lib/image-utils.ts (not imported directly —
// electron/main is built as a separate program from src/).
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;

export function createElectronLifecycle({
  app,
  browserWindow,
  clipboard,
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

  const registerWindowHandlers = (window: BrowserWindowLike): void => {
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
  };

  const createAndLoadWindow = async (url: string): Promise<BrowserWindowLike> => {
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

    registerWindowHandlers(window);
    await window.loadURL(url);
    logger.log('[electron] Window created and URL loaded');

    return window;
  };

  const handleCreateWindowFailure = (
    window: BrowserWindowLike | null,
    error: unknown
  ): BrowserWindowLike | null => {
    const failedWindow = window ?? mainWindow;

    if (failedWindow !== null && !failedWindow.isDestroyed()) {
      failedWindow.destroy();
    }
    if (mainWindow === failedWindow) {
      mainWindow = null;
    }

    logger.error('[electron] Failed to create window:', error);
    dialog.showErrorBox(
      'Startup Error',
      `Failed to start application:\n\n${error instanceof Error ? error.stack : String(error)}`
    );
    app.quit();

    return null;
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
      let window: BrowserWindowLike | null = null;

      try {
        logger.log('[electron] Starting createWindow...');
        logger.log('[electron] process.resourcesPath:', process.resourcesPath);
        logger.log('[electron] process.cwd():', process.cwd());

        if (stopServerPromise !== null) {
          await stopServerPromise;
        }

        const url = await serverManager.start();
        logger.log('[electron] Server started, URL:', url);

        window = await createAndLoadWindow(url);
        return window;
      } catch (error) {
        return handleCreateWindowFailure(window, error);
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
    ipcMain.handle('dialog:showOpen', (_event: unknown, options: OpenDialogOptions) => {
      const currentWindow = resolveMainWindow();
      if (!currentWindow) {
        return Promise.resolve({ canceled: true, filePaths: [] });
      }

      return dialog.showOpenDialog(currentWindow, options);
    });

    // Bridge the OS clipboard so the renderer can obtain a PNG for images that
    // the browser's paste event only exposes as TIFF (e.g. macOS screenshots).
    // This intentionally bypasses the browser's clipboard permission prompt, so
    // it's restricted to calls from the app's own main frame — tied to the
    // paste flow rather than reachable from an arbitrary subframe/webview.
    ipcMain.handle('clipboard:readImagePng', (event: IpcMainInvokeEventLike): string | null => {
      const currentWindow = resolveMainWindow();
      if (!currentWindow || event.senderFrame !== currentWindow.webContents.mainFrame) {
        return null;
      }

      const image = clipboard.readImage();
      if (image.isEmpty()) {
        return null;
      }
      const png = image.toPNG();
      if (png.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
        return null;
      }
      return Buffer.from(png).toString('base64');
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
