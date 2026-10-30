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

type ServerManagerDependency = ElectronLifecycleDependencies['serverManager'];
type TestServerManager = Omit<ServerManagerDependency, 'onUnexpectedExit'> &
  Partial<Pick<ServerManagerDependency, 'onUnexpectedExit'>>;

function createTestLifecycle(
  overrides: Partial<
    Pick<ElectronLifecycleDependencies, 'platform' | 'clipboard' | 'nativeImage'>
  > & { serverManager?: TestServerManager } = {}
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

describe('electron quit handling', () => {
  function preventableEvent() {
    return { preventDefault: vi.fn() };
  }

  it('stops the backend before letting the app quit', async () => {
    const stopGate = deferred<void>();
    const serverManager = {
      start: vi.fn().mockResolvedValue('http://localhost:3001'),
      stop: vi.fn(() => stopGate.promise),
    };
    const { lifecycle, app } = createTestLifecycle({ serverManager });

    const firstQuit = preventableEvent();
    lifecycle.handleBeforeQuit(firstQuit);
    const repeatedQuit = preventableEvent();
    lifecycle.handleBeforeQuit(repeatedQuit);

    expect(firstQuit.preventDefault).toHaveBeenCalledTimes(1);
    expect(repeatedQuit.preventDefault).toHaveBeenCalledTimes(1);
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();

    stopGate.resolve();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));

    const finalQuit = preventableEvent();
    lifecycle.handleBeforeQuit(finalQuit);
    expect(finalQuit.preventDefault).not.toHaveBeenCalled();
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
  });

  it('still quits when the backend fails to stop', async () => {
    const serverManager = {
      start: vi.fn().mockResolvedValue('http://localhost:3001'),
      stop: vi.fn().mockRejectedValue(new Error('stop failed')),
    };
    const { lifecycle, app } = createTestLifecycle({ serverManager });

    lifecycle.handleBeforeQuit(preventableEvent());

    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
  });

  it('does not report a startup error when quitting cancels a starting backend', async () => {
    let rejectStart!: (error: Error) => void;
    const serverManager = {
      start: vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectStart = reject;
          })
      ),
      stop: vi.fn(() => {
        rejectStart(new Error('Backend startup was cancelled by a stop request'));
        return Promise.resolve();
      }),
    };
    const { lifecycle, app, dialog } = createTestLifecycle({ serverManager });

    const createPromise = lifecycle.createWindow();
    await vi.waitFor(() => expect(serverManager.start).toHaveBeenCalled());
    lifecycle.handleBeforeQuit(preventableEvent());

    await expect(createPromise).resolves.toBeNull();
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
  });

  it('does not start a new backend when activated while quitting', async () => {
    const stopGate = deferred<void>();
    const serverManager = {
      start: vi.fn().mockResolvedValue('http://localhost:3001'),
      stop: vi.fn(() => stopGate.promise),
    };
    const { lifecycle, app } = createTestLifecycle({ serverManager });

    // macOS: no window is open; the Dock icon is clicked while the quit stops the backend.
    lifecycle.handleBeforeQuit(preventableEvent());
    const activatePromise = lifecycle.handleActivate();
    stopGate.resolve();
    await activatePromise;

    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(serverManager.start).not.toHaveBeenCalled();
    expect(FakeBrowserWindow.instances).toHaveLength(0);
  });

  it('does not start a new backend when quitting begins while a window waits for a stop', async () => {
    const stopGate = deferred<void>();
    const serverManager = {
      start: vi.fn().mockResolvedValue('http://localhost:3001'),
      stop: vi.fn(() => stopGate.promise),
    };
    const { lifecycle, app } = createTestLifecycle({ serverManager });

    lifecycle.handleWindowAllClosed();
    const activatePromise = lifecycle.handleActivate();
    lifecycle.handleBeforeQuit(preventableEvent());
    stopGate.resolve();

    await expect(activatePromise).resolves.toBeUndefined();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    expect(serverManager.start).not.toHaveBeenCalled();
    expect(FakeBrowserWindow.instances).toHaveLength(0);
  });

  it('registers before-quit and backend exit handlers', () => {
    const { lifecycle, app, serverManager } = createTestLifecycle();

    lifecycle.registerAppHandlers();

    expect(app.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
    expect(serverManager.onUnexpectedExit).toHaveBeenCalledWith(expect.any(Function));
  });
});

describe('unexpected backend exit', () => {
  it('restarts the backend and reloads the window when the user chooses Restart', async () => {
    const serverManager = {
      start: vi
        .fn()
        .mockResolvedValueOnce('http://localhost:3001')
        .mockResolvedValueOnce('http://localhost:3002'),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const { lifecycle, dialog, app } = createTestLifecycle({ serverManager });
    const window = await lifecycle.createWindow();

    await lifecycle.handleBackendExit({ code: 9 });

    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['Restart', 'Quit'],
        detail: expect.stringContaining('code 9'),
      })
    );
    expect(serverManager.start).toHaveBeenCalledTimes(2);
    expect(window?.loadURL).toHaveBeenLastCalledWith('http://localhost:3002');
    expect(FakeBrowserWindow.instances).toHaveLength(1);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('creates a window after restarting when none is open', async () => {
    const { lifecycle, serverManager } = createTestLifecycle();

    await lifecycle.handleBackendExit({ code: 1 });

    expect(serverManager.start).toHaveBeenCalledTimes(1);
    expect(FakeBrowserWindow.instances).toHaveLength(1);
  });

  it('quits when the user chooses Quit', async () => {
    const { lifecycle, dialog, app, serverManager } = createTestLifecycle();
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });

    await lifecycle.handleBackendExit({ code: 1 });

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(serverManager.start).not.toHaveBeenCalled();
  });

  it('shows the startup error and quits when the restart fails', async () => {
    const serverManager = {
      start: vi
        .fn()
        .mockResolvedValueOnce('http://localhost:3001')
        .mockRejectedValueOnce(new Error('migration failed')),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const { lifecycle, dialog, app } = createTestLifecycle({ serverManager });
    await lifecycle.createWindow();

    await lifecycle.handleBackendExit({ code: 1 });

    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'Startup Error',
      expect.stringContaining('migration failed')
    );
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { platform: 'darwin', quitCalls: 0 },
    { platform: 'linux', quitCalls: 1 },
  ] as const)(
    'does not report a startup error when closing the window cancels a restart ($platform)',
    async ({ platform, quitCalls }) => {
      let rejectRestart!: (error: Error) => void;
      const serverManager = {
        start: vi
          .fn()
          .mockResolvedValueOnce('http://localhost:3001')
          .mockReturnValueOnce(
            new Promise<string>((_resolve, reject) => {
              rejectRestart = reject;
            })
          ),
        stop: vi.fn(() => {
          rejectRestart(new Error('Backend startup was cancelled by a stop request'));
          return Promise.resolve();
        }),
      };
      const { lifecycle, dialog, app } = createTestLifecycle({ serverManager, platform });
      await lifecycle.createWindow();

      const exitHandled = lifecycle.handleBackendExit({ code: 1 });
      await vi.waitFor(() => expect(serverManager.start).toHaveBeenCalledTimes(2));
      // While the restarted backend is starting, the user closes the window.
      FakeBrowserWindow.instances[0]?.close();
      lifecycle.handleWindowAllClosed();
      await exitHandled;

      expect(serverManager.stop).toHaveBeenCalledTimes(1);
      expect(dialog.showErrorBox).not.toHaveBeenCalled();
      // Only closing the last window quits, and only off macOS.
      await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(quitCalls));
    }
  );

  it('prompts again when the restarted backend crashes during restart', async () => {
    const restartGate = deferred<string>();
    const serverManager = {
      start: vi
        .fn()
        .mockResolvedValueOnce('http://localhost:3001')
        .mockReturnValueOnce(restartGate.promise),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const { lifecycle, dialog } = createTestLifecycle({ serverManager });
    await lifecycle.createWindow();

    const firstExit = lifecycle.handleBackendExit({ code: 1 });
    await vi.waitFor(() => expect(serverManager.start).toHaveBeenCalledTimes(2));
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    await lifecycle.handleBackendExit({ code: 2 });

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    restartGate.resolve('http://localhost:3002');
    await firstExit;
  });

  it('shows one prompt for overlapping exits and none while quitting', async () => {
    const prompt = deferred<{ response: number; checkboxChecked: boolean }>();
    const { lifecycle, dialog, serverManager } = createTestLifecycle();
    vi.mocked(dialog.showMessageBox).mockReturnValue(prompt.promise);

    const first = lifecycle.handleBackendExit({ code: 1 });
    await lifecycle.handleBackendExit({ code: 1 });
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);

    lifecycle.handleBeforeQuit({ preventDefault: vi.fn() });
    prompt.resolve({ response: 0, checkboxChecked: false });
    await first;

    expect(serverManager.start).not.toHaveBeenCalled();
    await lifecycle.handleBackendExit({ code: 1 });
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
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

  it.each(['image/tiff', 'image/webp', 'image/bmp', 'image/gif'])(
    'accepts the normalized image payload when only %s is advertised',
    async (type) => {
      const { lifecycle, ipcMain } = createTestLifecycle({
        clipboard: { read: async () => [imageItem(type, new Uint8Array([1, 2, 3]))] },
        nativeImage: {
          createFromBuffer: (bytes) => ({
            isEmpty: () => !bytes.equals(Buffer.from([1, 2, 3])),
            toPNG: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          }),
        },
      });
      lifecycle.registerIpcHandlers();
      const window = await lifecycle.createWindow();
      expect(
        await getClipboardHandler(ipcMain)({ senderFrame: window?.webContents.mainFrame })
      ).toBe('iVBORw==');
    }
  );

  it('prefers JPEG over an earlier alternative image representation', async () => {
    const { handler, frame } = await setup([
      imageItem('image/tiff', new Uint8Array([1])),
      imageItem('image/jpeg', new Uint8Array([2])),
    ]);
    expect(await handler({ senderFrame: frame })).toBe('Ag==');
  });

  it.each([
    ['empty clipboard', []],
    [
      'raw TIFF without a normalized image type',
      [imageItem('electron application/osclipboard;format="public.tiff"', new Uint8Array([1]))],
    ],
    [
      'oversized alternative image',
      [imageItem('image/webp', new Uint8Array(10 * 1024 * 1024 + 1))],
    ],
    ['undecodable alternative image', [imageItem('image/tiff', new Uint8Array())]],
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
