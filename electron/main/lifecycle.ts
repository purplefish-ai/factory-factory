import type {
  BrowserWindowConstructorOptions,
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from 'electron';

interface PreventableEventLike {
  preventDefault(): void;
}

interface AppLike {
  on(event: 'activate' | 'window-all-closed', listener: () => void): void;
  on(event: 'before-quit', listener: (event: PreventableEventLike) => void): void;
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
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
}

interface NativeImageLike {
  isEmpty(): boolean;
  toPNG(): Uint8Array;
}

interface ClipboardLike {
  read(): Promise<
    Array<{
      types: readonly string[];
      getType(type: string): Promise<unknown>;
    }>
  >;
}

interface NativeImageFactoryLike {
  createFromBuffer(buffer: Buffer): NativeImageLike;
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
  onUnexpectedExit(listener: (details: { code: number }) => void): unknown;
}

interface LoggerLike {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ElectronLifecycleDependencies {
  app: AppLike;
  browserWindow: BrowserWindowConstructorLike;
  clipboard: ClipboardLike;
  nativeImage: NativeImageFactoryLike;
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
  handleBeforeQuit(event: PreventableEventLike): void;
  handleBackendExit(details: { code: number }): Promise<void>;
}

// Mirrors MAX_IMAGE_SIZE in src/lib/image-utils.ts (not imported directly —
// electron/main is built as a separate program from src/).
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;

async function readClipboardPng(
  clipboard: ClipboardLike,
  nativeImage: NativeImageFactoryLike
): Promise<string | null> {
  const items = await clipboard.read();
  const types = items.flatMap((item) => item.types);
  // Prefer PNG/JPEG, but accept other advertised image types: Electron's read-side
  // getType() normalizes image/* to PNG (or JPEG when explicitly requested).
  // Raw osclipboard payloads do not receive that conversion.
  const mimeType =
    ['image/png', 'image/jpeg'].find((type) => types.includes(type)) ??
    types.find((type) => type.startsWith('image/'));
  if (!mimeType) {
    return null;
  }
  const item = items.find((candidate) => candidate.types.includes(mimeType));
  if (!item) {
    return null;
  }
  const blob = await item.getType(mimeType);
  if (!(blob instanceof Blob) || blob.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    return null;
  }
  const bytes = Buffer.from(await blob.arrayBuffer());
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) {
    return null;
  }
  const png = image.toPNG();
  if (png.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    return null;
  }
  return Buffer.from(png).toString('base64');
}

export function createElectronLifecycle({
  app,
  browserWindow,
  clipboard,
  nativeImage,
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
  // Set once quitting starts: the backend is being stopped for good.
  let quitting = false;
  // Set after the backend has stopped, so the next quit is allowed through.
  let readyToQuit = false;
  let backendExitPromptOpen = false;

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

    if (quitting) {
      // Quitting stops a backend that is still starting; that is not a failure.
      logger.log('[electron] Window creation stopped because the app is quitting');
      return null;
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

  // Stop the backend before quitting so agent and terminal processes it owns
  // are shut down instead of orphaned.
  const handleBeforeQuit = (event: PreventableEventLike): void => {
    if (readyToQuit) {
      return;
    }
    event.preventDefault();
    if (quitting) {
      return;
    }
    quitting = true;
    logger.log('[electron] Quit requested, stopping backend first...');
    void stopServer().finally(() => {
      readyToQuit = true;
      app.quit();
    });
  };

  const restartBackend = async (): Promise<void> => {
    const window = resolveMainWindow();
    if (!window) {
      await createWindow();
      return;
    }
    try {
      const url = await serverManager.start();
      await window.loadURL(url);
    } catch (error) {
      handleCreateWindowFailure(window, error);
    }
  };

  const handleBackendExit = async ({ code }: { code: number }): Promise<void> => {
    if (quitting || backendExitPromptOpen) {
      return;
    }
    backendExitPromptOpen = true;
    let response: number;
    try {
      ({ response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Backend Stopped',
        message: 'The Factory Factory backend stopped unexpectedly.',
        detail: `It exited with code ${code}. Running agents and terminals were stopped. Restart the backend to keep working, or quit.`,
        buttons: ['Restart', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }));
    } finally {
      // Clear before restarting so a crash of the restarted backend prompts again.
      backendExitPromptOpen = false;
    }
    if (quitting) {
      return;
    }
    if (response !== 0) {
      app.quit();
      return;
    }
    logger.log('[electron] Restarting backend after unexpected exit...');
    await restartBackend();
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
    ipcMain.handle(
      'clipboard:readImagePng',
      async (event: IpcMainInvokeEventLike): Promise<string | null> => {
        const currentWindow = resolveMainWindow();
        if (!currentWindow || event.senderFrame !== currentWindow.webContents.mainFrame) {
          return null;
        }

        const senderFrame = event.senderFrame;
        const png = await readClipboardPng(clipboard, nativeImage);
        // A window may close or navigate while the asynchronous clipboard read is pending.
        if (
          currentWindow.isDestroyed() ||
          resolveMainWindow() !== currentWindow ||
          currentWindow.webContents.mainFrame !== senderFrame
        ) {
          return null;
        }
        return png;
      }
    );
  };

  const registerAppHandlers = (): void => {
    app.on('activate', () => {
      void handleActivate();
    });

    app.on('window-all-closed', () => {
      handleWindowAllClosed();
    });

    app.on('before-quit', (event) => {
      handleBeforeQuit(event);
    });

    serverManager.onUnexpectedExit((details) => {
      void handleBackendExit(details);
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
    handleBeforeQuit,
    handleBackendExit,
  };
}

export type { BrowserWindowLike as ElectronLifecycleBrowserWindow };
