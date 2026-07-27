import { describe, expect, it, vi } from 'vitest';
import {
  createElectronLifecycle,
  type ElectronLifecycleBrowserWindow,
  type ElectronLifecycleDependencies,
} from './lifecycle.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

class FakeBrowserWindow implements ElectronLifecycleBrowserWindow {
  static windows: FakeBrowserWindow[] = [];
  static instances: FakeBrowserWindow[] = [];
  static loadUrlImpl: (url: string) => Promise<void> = () => Promise.resolve();

  static getAllWindows(): FakeBrowserWindow[] {
    return [...FakeBrowserWindow.windows];
  }

  readonly webContents = {
    send: vi.fn(),
    mainFrame: {},
  };

  readonly loadURL = vi.fn((url: string) => FakeBrowserWindow.loadUrlImpl(url));
  readonly destroy = vi.fn(() => this.close());
  readonly show = vi.fn();
  readonly focus = vi.fn();

  private readonly listeners: Record<'focus' | 'blur' | 'closed', Array<() => void>> = {
    focus: [],
    blur: [],
    closed: [],
  };
  private destroyed = false;

  constructor(_options: unknown) {
    FakeBrowserWindow.windows.push(this);
    FakeBrowserWindow.instances.push(this);
  }

  on(event: 'focus' | 'blur' | 'closed', listener: () => void): void {
    this.listeners[event].push(listener);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  close(): void {
    this.destroyed = true;
    FakeBrowserWindow.windows = FakeBrowserWindow.windows.filter((window) => window !== this);
    for (const listener of this.listeners.closed) {
      listener();
    }
  }
}

function createTestLifecycle(
  overrides: Partial<
    Pick<ElectronLifecycleDependencies, 'serverManager' | 'platform' | 'clipboard'>
  > = {}
) {
  FakeBrowserWindow.windows = [];
  FakeBrowserWindow.instances = [];
  FakeBrowserWindow.loadUrlImpl = () => Promise.resolve();

  const app: ElectronLifecycleDependencies['app'] = {
    on: vi.fn(),
    whenReady: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn(),
  };

  const dialog: ElectronLifecycleDependencies['dialog'] = {
    showErrorBox: vi.fn(),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/file'] }),
  };

  const ipcMain: ElectronLifecycleDependencies['ipcMain'] = {
    handle: vi.fn(),
  };

  const clipboard: ElectronLifecycleDependencies['clipboard'] =
    overrides.clipboard ??
    ({
      readImage: vi.fn(() => ({
        isEmpty: () => true,
        toPNG: () => new Uint8Array(),
      })),
    } satisfies ElectronLifecycleDependencies['clipboard']);

  const logger: ElectronLifecycleDependencies['logger'] = {
    log: vi.fn(),
    error: vi.fn(),
  };

  const serverManager =
    overrides.serverManager ??
    ({
      start: vi.fn().mockResolvedValue('http://localhost:3001'),
      stop: vi.fn().mockResolvedValue(undefined),
    } satisfies ElectronLifecycleDependencies['serverManager']);

  const lifecycle = createElectronLifecycle({
    app,
    browserWindow: FakeBrowserWindow,
    clipboard,
    dialog,
    ipcMain,
    logger,
    platform: overrides.platform ?? 'darwin',
    preloadPath: '/tmp/preload.js',
    serverManager,
  });

  return { lifecycle, app, clipboard, dialog, ipcMain, serverManager };
}

describe('electron lifecycle coordination', () => {
  it('deduplicates concurrent createWindow calls', async () => {
    const startGate = deferred<string>();
    const serverManager = {
      start: vi.fn(() => startGate.promise),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const { lifecycle } = createTestLifecycle({ serverManager });

    const firstCreate = lifecycle.createWindow();
    const secondCreate = lifecycle.createWindow();

    expect(serverManager.start).toHaveBeenCalledTimes(1);

    startGate.resolve('http://localhost:3333');
    const [firstWindow, secondWindow] = await Promise.all([firstCreate, secondCreate]);

    expect(firstWindow).toBe(secondWindow);
    expect(FakeBrowserWindow.instances).toHaveLength(1);
  });

  it('waits for in-flight stop before starting again on activate', async () => {
    const stopGate = deferred<void>();
    const serverManager = {
      start: vi
        .fn()
        .mockResolvedValueOnce('http://localhost:3001')
        .mockResolvedValueOnce('http://localhost:3002'),
      stop: vi.fn(() => stopGate.promise),
    };
    const { lifecycle } = createTestLifecycle({ serverManager });

    const firstWindow = await lifecycle.createWindow();
    expect(firstWindow).not.toBeNull();
    FakeBrowserWindow.instances[0]?.close();

    lifecycle.handleWindowAllClosed();
    expect(serverManager.stop).toHaveBeenCalledTimes(1);

    const activatePromise = lifecycle.handleActivate();
    await Promise.resolve();

    expect(serverManager.start).toHaveBeenCalledTimes(1);

    stopGate.resolve();
    await activatePromise;

    expect(serverManager.start).toHaveBeenCalledTimes(2);
    expect(FakeBrowserWindow.instances).toHaveLength(2);
  });

  it('handles loadURL failures in createWindow and quits', async () => {
    const loadError = new Error('load failed');

    const serverManager = {
      start: vi
        .fn()
        .mockResolvedValueOnce('http://localhost:3001')
        .mockResolvedValueOnce('http://localhost:3002'),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const { lifecycle, app, dialog } = createTestLifecycle({ serverManager });
    FakeBrowserWindow.loadUrlImpl = vi
      .fn()
      .mockRejectedValueOnce(loadError)
      .mockResolvedValueOnce(undefined);

    const result = await lifecycle.createWindow();

    expect(result).toBeNull();
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'Startup Error',
      expect.stringContaining('load failed')
    );
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(FakeBrowserWindow.instances[0]?.destroy).toHaveBeenCalledTimes(1);

    const retryWindow = await lifecycle.createWindow();

    expect(retryWindow).toBe(FakeBrowserWindow.instances[1]);
    expect(serverManager.start).toHaveBeenCalledTimes(2);
    expect(FakeBrowserWindow.instances).toHaveLength(2);
  });
});

describe('clipboard:readImagePng IPC handler', () => {
  function getClipboardHandler(ipcMain: ElectronLifecycleDependencies['ipcMain']) {
    const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
    const call = handleMock.mock.calls.find(([channel]) => channel === 'clipboard:readImagePng');
    if (!call) {
      throw new Error('clipboard:readImagePng handler was not registered');
    }
    return call[1] as (event: { senderFrame: unknown }) => string | null;
  }

  it('returns base64-encoded PNG when the request comes from the app window', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const clipboard: ElectronLifecycleDependencies['clipboard'] = {
      readImage: vi.fn(() => ({ isEmpty: () => false, toPNG: () => png })),
    };
    const { lifecycle, ipcMain } = createTestLifecycle({ clipboard });

    lifecycle.registerIpcHandlers();
    const window = await lifecycle.createWindow();
    const handler = getClipboardHandler(ipcMain);

    expect(handler({ senderFrame: window?.webContents.mainFrame })).toBe(
      Buffer.from(png).toString('base64')
    );
  });

  it('returns null when the clipboard has no image', async () => {
    const clipboard: ElectronLifecycleDependencies['clipboard'] = {
      readImage: vi.fn(() => ({ isEmpty: () => true, toPNG: () => new Uint8Array() })),
    };
    const { lifecycle, ipcMain } = createTestLifecycle({ clipboard });

    lifecycle.registerIpcHandlers();
    const window = await lifecycle.createWindow();
    const handler = getClipboardHandler(ipcMain);

    expect(handler({ senderFrame: window?.webContents.mainFrame })).toBeNull();
  });

  it('returns null for an image over the size limit', async () => {
    const oversizedPng = new Uint8Array(10 * 1024 * 1024 + 1);
    const clipboard: ElectronLifecycleDependencies['clipboard'] = {
      readImage: vi.fn(() => ({ isEmpty: () => false, toPNG: () => oversizedPng })),
    };
    const { lifecycle, ipcMain } = createTestLifecycle({ clipboard });

    lifecycle.registerIpcHandlers();
    const window = await lifecycle.createWindow();
    const handler = getClipboardHandler(ipcMain);

    expect(handler({ senderFrame: window?.webContents.mainFrame })).toBeNull();
  });

  it('returns null when the request does not come from the trusted app frame', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const clipboard: ElectronLifecycleDependencies['clipboard'] = {
      readImage: vi.fn(() => ({ isEmpty: () => false, toPNG: () => png })),
    };
    const { lifecycle, ipcMain } = createTestLifecycle({ clipboard });

    lifecycle.registerIpcHandlers();
    await lifecycle.createWindow();
    const handler = getClipboardHandler(ipcMain);

    expect(handler({ senderFrame: {} })).toBeNull();
  });

  it('returns null when there is no app window', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const clipboard: ElectronLifecycleDependencies['clipboard'] = {
      readImage: vi.fn(() => ({ isEmpty: () => false, toPNG: () => png })),
    };
    const { lifecycle, ipcMain } = createTestLifecycle({ clipboard });

    lifecycle.registerIpcHandlers();
    const handler = getClipboardHandler(ipcMain);

    expect(handler({ senderFrame: {} })).toBeNull();
  });
});
