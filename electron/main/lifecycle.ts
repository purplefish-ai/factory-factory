import type {
  BrowserWindowConstructorOptions,
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from 'electron';
import { z } from 'zod';
import type { DesktopCommand } from '../../src/types/electron.js';
import type { DesktopShell, DesktopShellWindow } from './desktop-shell.js';
import { classifyNavigation, getAppOrigin } from './external-links.js';
import { LOADING_PAGE_URL } from './loading-page.js';

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

interface NavigationEventLike extends PreventableEventLike {
  url: string;
  isMainFrame: boolean;
}

interface BrowserWindowLike extends Omit<DesktopShellWindow, 'on'> {
  loadURL(url: string): Promise<void>;
  on(event: 'focus' | 'blur' | 'close' | 'closed', listener: () => void): void;
  webContents: {
    send(channel: string, payload: boolean | DesktopCommand): void;
    mainFrame: WebFrameLike;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
    on(
      event: 'did-start-navigation',
      listener: (event: { isMainFrame: boolean; isSameDocument: boolean }) => void
    ): void;
    on(event: 'will-navigate', listener: (event: NavigationEventLike) => void): void;
    on(event: 'will-redirect', listener: (event: NavigationEventLike) => void): void;
  };
  destroy(): void;
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
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

interface ShellLike {
  openExternal(url: string): Promise<void>;
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
  desktopShell: DesktopShell;
  browserWindow: BrowserWindowConstructorLike;
  clipboard: ClipboardLike;
  nativeImage: NativeImageFactoryLike;
  dialog: DialogLike;
  ipcMain: IpcMainLike;
  logger: LoggerLike;
  platform: NodeJS.Platform;
  preloadPath: string;
  serverManager: ServerManagerLike;
  shell: ShellLike;
}

export interface ElectronLifecycleController {
  registerIpcHandlers(): void;
  dispatchAppCommand(command: DesktopCommand): Promise<void>;
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
  desktopShell,
  browserWindow,
  clipboard,
  nativeImage,
  dialog,
  ipcMain,
  logger,
  platform,
  preloadPath,
  serverManager,
  shell,
}: ElectronLifecycleDependencies): ElectronLifecycleController {
  let mainWindow: BrowserWindowLike | null = null;
  // Origin of the app URL last loaded into the window; null until then, so the
  // loading page treats every web URL as external.
  let appOrigin: string | null = null;
  let rendererReadyFrame: WebFrameLike | null = null;
  const pendingCommands: DesktopCommand[] = [];
  let createWindowPromise: Promise<BrowserWindowLike | null> | null = null;
  let stopServerPromise: Promise<void> | null = null;
  // Set once quitting starts: the backend is being stopped for good.
  let quitting = false;
  // Set after the backend has stopped, so the next quit is allowed through.
  let readyToQuit = false;
  let backendExitPromptOpen = false;
  // Counts stop requests, so a start that a stop cancelled (for example when
  // the last window closes) is not reported as a startup failure.
  let stopRequestCount = 0;

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
    stopRequestCount++;
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

  const openExternally = (url: string): void => {
    shell.openExternal(url).catch((error: unknown) => {
      // The URL is untrusted and may carry tokens, so it is not logged, even
      // when the platform error message repeats it.
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        '[electron] Failed to open a link in the system browser:',
        message.split(url).join('<url>')
      );
    });
  };

  // Keep the app window on the app: links leaving its origin open in the
  // system browser, and URLs with other schemes are refused.
  const registerNavigationHandlers = (window: BrowserWindowLike): void => {
    // Never create in-app windows: they would inherit the preload bridge and
    // have no lifecycle handling. Same-origin targets (such as a relative
    // Markdown link) open in the browser too, which serves the same app.
    window.webContents.setWindowOpenHandler(({ url }) => {
      const decision = classifyNavigation(url, null);
      if (decision.action === 'external') {
        openExternally(decision.url);
      } else {
        logger.log('[electron] Blocked opening a window for an unsupported URL');
      }
      return { action: 'deny' };
    });

    const guardTopLevelNavigation = (event: NavigationEventLike): void => {
      if (!event.isMainFrame) {
        return;
      }
      const decision = classifyNavigation(event.url, appOrigin);
      if (decision.action === 'internal') {
        return;
      }
      event.preventDefault();
      if (decision.action === 'external') {
        openExternally(decision.url);
      } else {
        logger.log('[electron] Blocked navigation to an unsupported URL');
      }
    };
    window.webContents.on('will-navigate', guardTopLevelNavigation);
    window.webContents.on('will-redirect', guardTopLevelNavigation);
  };

  const loadApp = (window: BrowserWindowLike, url: string): Promise<void> => {
    rendererReadyFrame = null;
    appOrigin = getAppOrigin(url);
    return window.loadURL(url);
  };

  const registerWindowHandlers = (window: BrowserWindowLike): void => {
    registerNavigationHandlers(window);
    window.webContents.on('did-start-navigation', (event) => {
      // A full reload replaces preload listeners; SPA route changes do not.
      if (event.isMainFrame && !event.isSameDocument) rendererReadyFrame = null;
    });

    window.on('focus', () => {
      window.webContents.send('window-focus-changed', true);
    });

    window.on('blur', () => {
      window.webContents.send('window-focus-changed', false);
    });

    window.on('closed', () => {
      if (mainWindow === window) {
        rendererReadyFrame = null;
        pendingCommands.length = 0;
        mainWindow = null;
      }
    });
  };

  // Open the window with a local loading page so it appears while the backend
  // starts; the app URL is loaded once the backend is ready.
  const openLoadingWindow = (): {
    window: BrowserWindowLike;
    loadingPageLoaded: Promise<void>;
  } => {
    const window = new browserWindow({
      width: 1400,
      height: 900,
      ...desktopShell.getWindowOptions(),
      title: 'Factory Factory',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWindow = window;
    registerWindowHandlers(window);
    desktopShell.registerWindow(window);

    // The loading page is cosmetic: a failure to show it must not block startup.
    const loadingPageLoaded = window.loadURL(LOADING_PAGE_URL).catch((error: unknown) => {
      logger.error('[electron] Failed to show the loading page:', error);
    });
    logger.log('[electron] Window created, waiting for backend...');

    return { window, loadingPageLoaded };
  };

  const handleCreateWindowFailure = (
    window: BrowserWindowLike | null,
    error: unknown,
    stopRequestCountAtStart: number
  ): BrowserWindowLike | null => {
    const failedWindow = window ?? mainWindow;
    // Classify before destroying the window: destroying the last window emits
    // `window-all-closed`, which requests a stop and would look like a cancellation.
    const stoppedByQuit = quitting;
    const stoppedByStopRequest = stopRequestCount !== stopRequestCountAtStart;

    if (failedWindow !== null && !failedWindow.isDestroyed()) {
      failedWindow.destroy();
    }
    if (mainWindow === failedWindow) {
      mainWindow = null;
    }

    if (stoppedByQuit) {
      // Quitting stops a backend that is still starting; that is not a failure.
      logger.log('[electron] Window creation stopped because the app is quitting');
      return null;
    }
    if (stoppedByStopRequest) {
      // Closing the last window stops the backend and cancels a start in flight.
      logger.log('[electron] Window creation stopped because the backend was stopped');
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

  const loadAppWhenReady = async (
    window: BrowserWindowLike,
    loadingPageLoaded: Promise<void>,
    url: string
  ): Promise<BrowserWindowLike | null> => {
    // Let the loading page settle so loading the app does not abort it.
    if (!window.isDestroyed()) {
      await loadingPageLoaded;
    }
    if (window.isDestroyed()) {
      // The user closed the window while the backend started; closing the
      // last window already stops the backend (and quits off macOS).
      logger.log('[electron] Window closed before the backend was ready');
      return null;
    }

    await loadApp(window, url);
    logger.log('[electron] App URL loaded');
    return window;
  };

  const createWindow = (): Promise<BrowserWindowLike | null> => {
    const existingWindow = resolveMainWindow();
    if (existingWindow) {
      existingWindow.show();
      existingWindow.focus();
    }

    // A window that is still waiting for the backend resolves with the creation.
    if (createWindowPromise !== null) {
      return createWindowPromise;
    }
    if (existingWindow) {
      return Promise.resolve(existingWindow);
    }

    createWindowPromise = (async () => {
      let window: BrowserWindowLike | null = null;
      const stopRequestCountAtStart = stopRequestCount;

      try {
        logger.log('[electron] Starting createWindow...');
        logger.log('[electron] process.resourcesPath:', process.resourcesPath);
        logger.log('[electron] process.cwd():', process.cwd());

        if (stopServerPromise !== null) {
          await stopServerPromise;
        }
        if (quitting) {
          // The quit already stopped the backend; a backend started now would never be stopped.
          return null;
        }

        const loading = openLoadingWindow();
        window = loading.window;

        const url = await serverManager.start();
        logger.log('[electron] Server started, URL:', url);

        return await loadAppWhenReady(window, loading.loadingPageLoaded, url);
      } catch (error) {
        return handleCreateWindowFailure(window, error, stopRequestCountAtStart);
      } finally {
        createWindowPromise = null;
      }
    })();

    return createWindowPromise;
  };

  const flushAppCommands = (): void => {
    const window = resolveMainWindow();
    if (!(window && appOrigin) || rendererReadyFrame !== window.webContents.mainFrame) {
      return;
    }
    for (const command of pendingCommands.splice(0)) {
      window.webContents.send('app:command', command);
    }
  };

  const dispatchAppCommand = async (command: DesktopCommand): Promise<void> => {
    // A cold window or renderer remount must subscribe before a native command
    // can be delivered. Keep a bounded queue rather than silently dropping it.
    if (pendingCommands.length >= 32) {
      pendingCommands.shift();
    }
    pendingCommands.push(command);
    await createWindow();
    flushAppCommands();
  };

  const handleActivate = async (): Promise<void> => {
    if (quitting || browserWindow.getAllWindows().length > 0) {
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
    const stopRequestCountAtStart = stopRequestCount;
    try {
      const url = await serverManager.start();
      await loadApp(window, url);
    } catch (error) {
      handleCreateWindowFailure(window, error, stopRequestCountAtStart);
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
    ipcMain.handle('app:commands-ready', (event, ready: unknown) => {
      const window = resolveMainWindow();
      if (
        !(window && appOrigin) ||
        event.senderFrame !== window.webContents.mainFrame ||
        typeof ready !== 'boolean'
      ) {
        return;
      }
      rendererReadyFrame = ready ? event.senderFrame : null;
      if (ready) {
        flushAppCommands();
      }
    });
    ipcMain.handle('window:background-color', (event, color: unknown) => {
      const window = resolveMainWindow();
      if (!(window && appOrigin) || event.senderFrame !== window.webContents.mainFrame) {
        return;
      }
      const parsed = z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .safeParse(color);
      if (parsed.success) {
        desktopShell.setBackgroundColor(parsed.data);
      }
    });
    // Only the app's trusted top-level frame may raise the desktop window.
    ipcMain.handle('window:focus', (event: IpcMainInvokeEventLike): void => {
      const currentWindow = resolveMainWindow();
      if (
        !(currentWindow && appOrigin) ||
        event.senderFrame !== currentWindow.webContents.mainFrame
      ) {
        return;
      }
      if (currentWindow.isMinimized()) {
        currentWindow.restore();
      }
      currentWindow.show();
      currentWindow.focus();
    });

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
        desktopShell.installMenu();
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
    dispatchAppCommand,
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
