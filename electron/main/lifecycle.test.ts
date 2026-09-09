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
    Pick<ElectronLifecycleDependencies, 'serverManager' | 'platform' | 'clipboard' | 'nativeImage'>
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
    nativeImage,
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
    return call[1] as (event: { senderFrame: unknown }) => Promise<string | null>;
  }

  function imageItem(type: string, bytes: Uint8Array) {
    return { types: [type], getType: async () => new Blob([new Uint8Array(bytes)], { type }) };
  }

  async function setup(items: ReturnType<typeof imageItem>[]) {
    const clipboard = { read: vi.fn().mockResolvedValue(items) };
    const context = createTestLifecycle({ clipboard });
    context.lifecycle.registerIpcHandlers();
    const window = await context.lifecycle.createWindow();
    return {
      ...context,
      handler: getClipboardHandler(context.ipcMain),
      frame: window?.webContents.mainFrame,
    };
  }

  it('returns base64 PNG and prefers PNG over an earlier JPEG item', async () => {
    const { handler, frame } = await setup([
      imageItem('image/jpeg', new Uint8Array([1, 2])),
      imageItem('image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    ]);
    expect(await handler({ senderFrame: frame })).toBe('iVBORw==');
  });

  it('decodes JPEG and returns the converted PNG bytes', async () => {
    const { lifecycle, ipcMain } = createTestLifecycle({
      clipboard: { read: async () => [imageItem('image/jpeg', new Uint8Array([0xff, 0xd8]))] },
      nativeImage: {
        createFromBuffer: (buffer) => ({
          isEmpty: () => !buffer.equals(Buffer.from([0xff, 0xd8])),
          toPNG: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        }),
      },
    });
    lifecycle.registerIpcHandlers();
    const window = await lifecycle.createWindow();
    expect(await getClipboardHandler(ipcMain)({ senderFrame: window?.webContents.mainFrame })).toBe(
      'iVBORw=='
    );
  });

  it.each([
    ['empty clipboard', []],
    ['text-only clipboard', [imageItem('text/plain', new Uint8Array([65]))]],
    ['empty image', [imageItem('image/png', new Uint8Array())]],
    ['oversized image', [imageItem('image/png', new Uint8Array(10 * 1024 * 1024 + 1))]],
  ])('returns null for an %s', async (_name, items) => {
    const { handler, frame } = await setup(items);
    expect(await handler({ senderFrame: frame })).toBeNull();
  });

  it('rejects PNG output that exceeds the limit after conversion', async () => {
    const { lifecycle, ipcMain } = createTestLifecycle({
      clipboard: { read: async () => [imageItem('image/jpeg', new Uint8Array([1]))] },
      nativeImage: {
        createFromBuffer: () => ({
          isEmpty: () => false,
          toPNG: () => new Uint8Array(10 * 1024 * 1024 + 1),
        }),
      },
    });
    lifecycle.registerIpcHandlers();
    const window = await lifecycle.createWindow();
    expect(
      await getClipboardHandler(ipcMain)({ senderFrame: window?.webContents.mainFrame })
    ).toBeNull();
  });

  it('does not read the clipboard for an untrusted frame', async () => {
    const { handler, clipboard } = await setup([]);
    expect(await handler({ senderFrame: {} })).toBeNull();
    expect(clipboard.read).not.toHaveBeenCalled();
  });

  it('does not read the clipboard without an app window', async () => {
    const { lifecycle, ipcMain, clipboard } = createTestLifecycle();
    lifecycle.registerIpcHandlers();
    expect(await getClipboardHandler(ipcMain)({ senderFrame: {} })).toBeNull();
    expect(clipboard.read).not.toHaveBeenCalled();
  });

  it('does not return clipboard data after the trusted main frame navigates', async () => {
    const pendingRead = deferred<ReturnType<typeof imageItem>[]>();
    const { lifecycle, ipcMain } = createTestLifecycle({
      clipboard: { read: () => pendingRead.promise },
    });
    lifecycle.registerIpcHandlers();
    const window = await lifecycle.createWindow();
    const result = getClipboardHandler(ipcMain)({ senderFrame: window?.webContents.mainFrame });
    if (!window) {
      throw new Error('Expected a window');
    }
    window.webContents.mainFrame = {};
    pendingRead.resolve([imageItem('image/png', new Uint8Array([1]))]);
    expect(await result).toBeNull();
  });

  it('does not return clipboard data if the window closes while reading', async () => {
    let resolveRead!: (items: ReturnType<typeof imageItem>[]) => void;
    const { lifecycle, ipcMain } = createTestLifecycle({
      clipboard: {
        read: () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      },
    });
    lifecycle.registerIpcHandlers();
    const window = await lifecycle.createWindow();
    const result = getClipboardHandler(ipcMain)({ senderFrame: window?.webContents.mainFrame });
    window?.destroy();
    resolveRead([imageItem('image/png', new Uint8Array([1]))]);
    expect(await result).toBeNull();
  });
});
