import type { BrowserWindowConstructorOptions } from 'electron';
import { vi } from 'vitest';
import {
  createElectronLifecycle,
  type ElectronLifecycleBrowserWindow,
  type ElectronLifecycleDependencies,
} from './lifecycle.js';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

interface FakeNavigationEvent {
  url: string;
  isMainFrame: boolean;
  isSameDocument: boolean;
  preventDefault(): void;
}

type NavigationEventName = 'will-navigate' | 'will-redirect' | 'did-start-navigation';

export class FakeBrowserWindow implements ElectronLifecycleBrowserWindow {
  static windows: FakeBrowserWindow[] = [];
  static instances: FakeBrowserWindow[] = [];
  static loadUrlImpl: (url: string) => Promise<void> = () => Promise.resolve();
  // Electron emits `window-all-closed` synchronously when the last window closes.
  static onAllWindowsClosed: (() => void) | null = null;

  static getAllWindows(): FakeBrowserWindow[] {
    return [...FakeBrowserWindow.windows];
  }

  windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | null = null;
  private readonly navigationListeners: Record<
    NavigationEventName,
    Array<(event: FakeNavigationEvent) => void>
  > = { 'will-navigate': [], 'will-redirect': [], 'did-start-navigation': [] };

  readonly webContents = {
    send: vi.fn(),
    mainFrame: {},
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => {
      this.windowOpenHandler = handler;
    },
    on: (event: NavigationEventName, listener: (event: FakeNavigationEvent) => void) => {
      this.navigationListeners[event].push(listener);
    },
  };

  // Emits a navigation event and reports whether a listener prevented it.
  navigate(
    event: NavigationEventName,
    url: string,
    { isMainFrame = true, isSameDocument = false } = {}
  ): boolean {
    const navigation = { url, isMainFrame, isSameDocument, preventDefault: vi.fn() };
    for (const listener of this.navigationListeners[event]) {
      listener(navigation);
    }
    return navigation.preventDefault.mock.calls.length > 0;
  }

  readonly loadURL = vi.fn((url: string) => FakeBrowserWindow.loadUrlImpl(url));
  readonly destroy = vi.fn(() => this.close());
  readonly show = vi.fn();
  readonly focus = vi.fn();
  readonly isMinimized = vi.fn(() => true);
  readonly restore = vi.fn();
  readonly getNormalBounds = () => ({ x: 0, y: 0, width: 1400, height: 900 });
  readonly isMaximized = () => false;
  readonly maximize = vi.fn();
  readonly setBackgroundColor = vi.fn();

  private readonly listeners: Record<'focus' | 'blur' | 'close' | 'closed', Array<() => void>> = {
    focus: [],
    blur: [],
    close: [],
    closed: [],
  };
  private destroyed = false;

  constructor(readonly options: BrowserWindowConstructorOptions) {
    FakeBrowserWindow.windows.push(this);
    FakeBrowserWindow.instances.push(this);
  }

  on(event: 'focus' | 'blur' | 'close' | 'closed', listener: () => void): void {
    this.listeners[event].push(listener);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  close(): void {
    for (const listener of this.listeners.close) {
      listener();
    }
    this.destroyed = true;
    FakeBrowserWindow.windows = FakeBrowserWindow.windows.filter((window) => window !== this);
    for (const listener of this.listeners.closed) {
      listener();
    }
    if (FakeBrowserWindow.windows.length === 0) {
      FakeBrowserWindow.onAllWindowsClosed?.();
    }
  }
}

type ServerManagerDependency = ElectronLifecycleDependencies['serverManager'];
type TestServerManager = Omit<ServerManagerDependency, 'onUnexpectedExit'> &
  Partial<Pick<ServerManagerDependency, 'onUnexpectedExit'>>;

export function createTestLifecycle(
  overrides: Partial<
    Pick<ElectronLifecycleDependencies, 'platform' | 'clipboard' | 'nativeImage' | 'desktopShell'>
  > & { serverManager?: TestServerManager } = {}
) {
  FakeBrowserWindow.windows = [];
  FakeBrowserWindow.instances = [];
  FakeBrowserWindow.loadUrlImpl = () => Promise.resolve();
  FakeBrowserWindow.onAllWindowsClosed = null;

  const app: ElectronLifecycleDependencies['app'] = {
    on: vi.fn(),
    whenReady: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn(),
  };

  const dialog: ElectronLifecycleDependencies['dialog'] = {
    showErrorBox: vi.fn(),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/file'] }),
    showMessageBox: vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false }),
  };

  const ipcMain: ElectronLifecycleDependencies['ipcMain'] = {
    handle: vi.fn(),
  };

  const clipboard = overrides.clipboard ?? { read: vi.fn().mockResolvedValue([]) };
  const nativeImage = overrides.nativeImage ?? {
    createFromBuffer: (buffer: Buffer) => ({
      isEmpty: () => buffer.length === 0,
      toPNG: () => buffer,
    }),
  };

  const logger: ElectronLifecycleDependencies['logger'] = {
    log: vi.fn(),
    error: vi.fn(),
  };

  const serverManager: ServerManagerDependency = {
    onUnexpectedExit: vi.fn(),
    ...(overrides.serverManager ?? {
      start: vi.fn().mockResolvedValue('http://localhost:3001'),
      stop: vi.fn().mockResolvedValue(undefined),
    }),
  };

  const shell: ElectronLifecycleDependencies['shell'] = {
    openExternal: vi.fn().mockResolvedValue(undefined),
  };

  const desktopShell = overrides.desktopShell ?? {
    installMenu: vi.fn(),
    getWindowOptions: () => ({}),
    registerWindow: vi.fn(),
    setBackgroundColor: vi.fn(),
  };
  const lifecycle = createElectronLifecycle({
    app,
    desktopShell,
    browserWindow: FakeBrowserWindow,
    clipboard,
    nativeImage,
    dialog,
    ipcMain,
    logger,
    platform: overrides.platform ?? 'darwin',
    preloadPath: '/tmp/preload.js',
    serverManager,
    shell,
  });

  return { lifecycle, desktopShell, app, clipboard, dialog, ipcMain, logger, serverManager, shell };
}
