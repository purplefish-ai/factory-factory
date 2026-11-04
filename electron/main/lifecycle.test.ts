import { describe, expect, it, vi } from 'vitest';
import type { ElectronLifecycleDependencies } from './lifecycle.js';
import { createTestLifecycle, deferred, FakeBrowserWindow } from './lifecycle.test-support.js';
import { LOADING_PAGE_URL } from './loading-page.js';

describe('electron lifecycle coordination', () => {
  it('applies shell bounds before creating the window and registers persistence', async () => {
    const desktopShell = {
      installMenu: vi.fn(),
      setBackgroundColor: vi.fn(),
      getWindowOptions: () => ({
        width: 1100,
        height: 720,
        x: 50,
        y: 60,
        minWidth: 640,
        backgroundColor: '#ffffff',
      }),
      registerWindow: vi.fn(),
    };
    const { lifecycle } = createTestLifecycle({ desktopShell });
    await lifecycle.createWindow();
    const window = FakeBrowserWindow.instances[0]!;
    expect(window.options).toMatchObject({
      width: 1100,
      height: 720,
      x: 50,
      y: 60,
      minWidth: 640,
      backgroundColor: '#ffffff',
    });
    expect(desktopShell.registerWindow).toHaveBeenCalledWith(window);
  });

  it('queues menu commands until the trusted renderer subscribes, including cold startup', async () => {
    const startGate = deferred<string>();
    const { lifecycle, ipcMain } = createTestLifecycle({
      serverManager: {
        start: () => startGate.promise,
        stop: async () => undefined,
      },
    });
    lifecycle.registerIpcHandlers();
    const delivery = lifecycle.dispatchAppCommand('nav.settings');
    const window = FakeBrowserWindow.instances[0]!;
    expect(window.webContents.send).not.toHaveBeenCalledWith('app:command', 'nav.settings');
    startGate.resolve('http://localhost:3001');
    await delivery;
    expect(window.webContents.send).not.toHaveBeenCalledWith('app:command', 'nav.settings');
    const ready = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'app:commands-ready')![1];
    ready({ senderFrame: {} }, true);
    expect(window.webContents.send).not.toHaveBeenCalledWith('app:command', 'nav.settings');
    ready({ senderFrame: window.webContents.mainFrame }, true);
    expect(window.webContents.send).toHaveBeenLastCalledWith('app:command', 'nav.settings');
    ready({ senderFrame: window.webContents.mainFrame }, false);
    await lifecycle.dispatchAppCommand('app.search');
    expect(window.webContents.send).not.toHaveBeenCalledWith('app:command', 'app.search');
    ready({ senderFrame: window.webContents.mainFrame }, true);
    expect(window.webContents.send).toHaveBeenLastCalledWith('app:command', 'app.search');
    window.navigate('did-start-navigation', 'http://localhost:3001/projects', {
      isSameDocument: true,
    });
    await lifecycle.dispatchAppCommand('app.toggleSidebar');
    expect(window.webContents.send).toHaveBeenLastCalledWith('app:command', 'app.toggleSidebar');
    window.navigate('did-start-navigation', 'http://localhost:3001/projects');
    window.webContents.send.mockClear();
    await lifecycle.dispatchAppCommand('nav.newWorkspace');
    expect(window.webContents.send).not.toHaveBeenCalledWith('app:command', 'nav.newWorkspace');
    ready({ senderFrame: window.webContents.mainFrame }, true);
    expect(window.webContents.send).toHaveBeenLastCalledWith('app:command', 'nav.newWorkspace');
  });

  it('applies validated renderer background only from the trusted main frame', async () => {
    const { lifecycle, ipcMain, desktopShell } = createTestLifecycle();
    lifecycle.registerIpcHandlers();
    const window = await lifecycle.createWindow();
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'window:background-color')![1];
    handler({ senderFrame: {} }, '#123456');
    handler({ senderFrame: window!.webContents.mainFrame }, 'untrusted CSS');
    expect(desktopShell.setBackgroundColor).not.toHaveBeenCalled();
    handler({ senderFrame: window!.webContents.mainFrame }, '#123456');
    expect(desktopShell.setBackgroundColor).toHaveBeenCalledWith('#123456');
  });

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
    let failAppLoad = true;
    FakeBrowserWindow.loadUrlImpl = (url) => {
      if (url !== LOADING_PAGE_URL && failAppLoad) {
        failAppLoad = false;
        return Promise.reject(loadError);
      }
      return Promise.resolve();
    };

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

describe('window shown while the backend starts', () => {
  function gatedServerManager() {
    let rejectStart!: (error: Error) => void;
    let resolveStart!: (url: string) => void;
    const serverManager = {
      start: vi.fn(
        () =>
          new Promise<string>((resolve, reject) => {
            resolveStart = resolve;
            rejectStart = reject;
          })
      ),
      // Like ServerManager, a stop cancels a start in flight.
      stop: vi.fn(() => {
        rejectStart(new Error('Backend startup was cancelled by a stop request'));
        return Promise.resolve();
      }),
    };
    return {
      serverManager,
      resolveStart: (url: string) => resolveStart(url),
      rejectStart: (error: Error) => rejectStart(error),
    };
  }

  it('creates the window with a loading page before the backend is ready', async () => {
    const { serverManager, resolveStart } = gatedServerManager();
    const { lifecycle } = createTestLifecycle({ serverManager });

    const createPromise = lifecycle.createWindow();

    expect(serverManager.start).toHaveBeenCalledTimes(1);
    expect(FakeBrowserWindow.instances).toHaveLength(1);
    const window = FakeBrowserWindow.instances[0];
    expect(window?.loadURL).toHaveBeenCalledTimes(1);
    expect(window?.loadURL).toHaveBeenCalledWith(LOADING_PAGE_URL);

    resolveStart('http://localhost:3001');

    await expect(createPromise).resolves.toBe(window);
    expect(window?.loadURL).toHaveBeenCalledTimes(2);
    expect(window?.loadURL).toHaveBeenLastCalledWith('http://localhost:3001');
  });

  it('keeps the loading page self-contained', () => {
    const html = decodeURIComponent(
      LOADING_PAGE_URL.replace(/^data:text\/html;charset=utf-8,/, '')
    );

    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script|https?:|src=|href=/i);
  });

  it('keeps one loading window across activate and repeated createWindow calls', async () => {
    const { serverManager, resolveStart } = gatedServerManager();
    const { lifecycle } = createTestLifecycle({ serverManager });

    const createPromise = lifecycle.createWindow();
    // macOS raises existing windows on activate itself; only a missing window is created.
    await lifecycle.handleActivate();
    expect(FakeBrowserWindow.instances).toHaveLength(1);

    const secondCreate = lifecycle.createWindow();
    expect(FakeBrowserWindow.instances).toHaveLength(1);
    expect(FakeBrowserWindow.instances[0]?.focus).toHaveBeenCalledTimes(1);
    expect(serverManager.start).toHaveBeenCalledTimes(1);

    resolveStart('http://localhost:3001');
    const [first, second] = await Promise.all([createPromise, secondCreate]);
    expect(second).toBe(first);
    expect(first?.loadURL).toHaveBeenCalledTimes(2);
  });

  it.each([
    { platform: 'darwin', quitCalls: 0 },
    { platform: 'linux', quitCalls: 1 },
  ] as const)(
    'destroys the loading window and reports a backend start failure ($platform)',
    async ({ platform, quitCalls }) => {
      const { serverManager, rejectStart } = gatedServerManager();
      const { lifecycle, app, dialog } = createTestLifecycle({ serverManager, platform });
      FakeBrowserWindow.onAllWindowsClosed = () => lifecycle.handleWindowAllClosed();

      const createPromise = lifecycle.createWindow();
      rejectStart(new Error('migration failed'));

      await expect(createPromise).resolves.toBeNull();
      const window = FakeBrowserWindow.instances[0];
      expect(window?.destroy).toHaveBeenCalledTimes(1);
      expect(window?.loadURL).not.toHaveBeenCalledWith('http://localhost:3001');
      expect(FakeBrowserWindow.getAllWindows()).toHaveLength(0);
      // Destroying the last window requests a stop; that must not hide the error.
      expect(dialog.showErrorBox).toHaveBeenCalledWith(
        'Startup Error',
        expect.stringContaining('migration failed')
      );
      // The startup error quits everywhere; closing the window also quits off macOS.
      await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1 + quitCalls));
    }
  );

  it.each([
    { platform: 'darwin', quitCalls: 0 },
    { platform: 'linux', quitCalls: 1 },
  ] as const)(
    'stops the backend without an error when the loading window is closed ($platform)',
    async ({ platform, quitCalls }) => {
      const { serverManager } = gatedServerManager();
      const { lifecycle, app, dialog } = createTestLifecycle({ serverManager, platform });
      FakeBrowserWindow.onAllWindowsClosed = () => lifecycle.handleWindowAllClosed();

      const createPromise = lifecycle.createWindow();
      FakeBrowserWindow.instances[0]?.close();

      await expect(createPromise).resolves.toBeNull();
      expect(serverManager.stop).toHaveBeenCalledTimes(1);
      expect(dialog.showErrorBox).not.toHaveBeenCalled();
      expect(FakeBrowserWindow.instances[0]?.loadURL).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(quitCalls));
    }
  );

  it('does not load the app into a window closed just as the backend became ready', async () => {
    const startGate = deferred<string>();
    const serverManager = {
      start: vi.fn(() => startGate.promise),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const { lifecycle, dialog } = createTestLifecycle({ serverManager });

    const createPromise = lifecycle.createWindow();
    startGate.resolve('http://localhost:3001');
    FakeBrowserWindow.instances[0]?.close();

    await expect(createPromise).resolves.toBeNull();
    expect(FakeBrowserWindow.instances[0]?.loadURL).toHaveBeenCalledTimes(1);
    expect(dialog.showErrorBox).not.toHaveBeenCalled();

    // macOS: activating afterwards opens a new window and starts again.
    await lifecycle.handleActivate();
    expect(FakeBrowserWindow.instances).toHaveLength(2);
    expect(serverManager.start).toHaveBeenCalledTimes(2);
  });

  it('still loads the app when the loading page fails to load', async () => {
    const { lifecycle } = createTestLifecycle();
    FakeBrowserWindow.loadUrlImpl = (url) =>
      url === LOADING_PAGE_URL ? Promise.reject(new Error('ERR_ABORTED')) : Promise.resolve();

    const window = await lifecycle.createWindow();

    expect(window?.loadURL).toHaveBeenLastCalledWith('http://localhost:3001');
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

describe('links leaving the app window', () => {
  async function createAppWindow() {
    const serverManager = {
      start: vi
        .fn()
        .mockResolvedValueOnce('http://127.0.0.1:3001/')
        .mockResolvedValueOnce('http://127.0.0.1:3002/'),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const test = createTestLifecycle({ serverManager });
    await test.lifecycle.createWindow();
    const window = FakeBrowserWindow.instances[0];
    if (!window) {
      throw new Error('Expected an app window');
    }
    return { ...test, window };
  }

  it('opens new-window requests in the system browser and never creates app windows', async () => {
    const { window, shell } = await createAppWindow();

    for (const url of [
      'https://github.com/org/repo/pull/1',
      // Same-origin targets also go to the browser rather than an in-app window.
      'http://127.0.0.1:3001/projects',
      'mailto:team@example.com',
    ]) {
      expect(window.windowOpenHandler?.({ url })).toEqual({ action: 'deny' });
      expect(shell.openExternal).toHaveBeenLastCalledWith(url);
    }

    expect(shell.openExternal).toHaveBeenCalledTimes(3);
    expect(FakeBrowserWindow.instances).toHaveLength(1);
  });

  it('refuses new-window requests for unsupported schemes', async () => {
    const { window, shell } = await createAppWindow();

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://file/x', 'nope']) {
      expect(window.windowOpenHandler?.({ url })).toEqual({ action: 'deny' });
    }

    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('keeps app-origin navigation in the window and opens other web origins externally', async () => {
    const { window, shell } = await createAppWindow();

    expect(window.navigate('will-navigate', 'http://127.0.0.1:3001/projects/a')).toBe(false);
    expect(window.navigate('will-redirect', 'http://127.0.0.1:3001/login')).toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();

    expect(window.navigate('will-navigate', 'https://linear.app/team/issue/ABC-1')).toBe(true);
    expect(window.navigate('will-redirect', 'https://example.com/')).toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith('https://linear.app/team/issue/ABC-1');
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('blocks top-level navigation to unsupported schemes without opening them', async () => {
    const { window, shell } = await createAppWindow();

    expect(window.navigate('will-navigate', 'file:///Users/me/secret')).toBe(true);
    expect(window.navigate('will-navigate', 'custom-app://open')).toBe(true);

    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('leaves subframe redirects to the frame', async () => {
    const { window, shell } = await createAppWindow();

    expect(
      window.navigate('will-redirect', 'https://example.com/embed', { isMainFrame: false })
    ).toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('follows the app origin when a restarted backend moves to a new URL', async () => {
    const { window, lifecycle, shell } = await createAppWindow();

    await lifecycle.handleBackendExit({ code: 1 });

    expect(window.navigate('will-navigate', 'http://127.0.0.1:3002/projects')).toBe(false);
    expect(window.navigate('will-navigate', 'http://127.0.0.1:3001/projects')).toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith('http://127.0.0.1:3001/projects');
  });

  it('logs a failure to open a link without logging the URL', async () => {
    const { window, shell, logger } = await createAppWindow();
    const url = 'https://example.com/?token=secret';
    vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error(`No handler for ${url}`));

    window.windowOpenHandler?.({ url });
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());

    const logged = vi.mocked(logger.error).mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('No handler for <url>');
    expect(logged).not.toContain('secret');
  });
});

describe('window:focus IPC handler', () => {
  it('restores, shows and focuses only the trusted main frame', async () => {
    const { lifecycle, ipcMain } = createTestLifecycle();
    const window = await lifecycle.createWindow();
    lifecycle.registerIpcHandlers();
    const handleMock = vi.mocked(ipcMain.handle);
    const call = handleMock.mock.calls.find(([channel]) => channel === 'window:focus');
    expect(call).toBeDefined();
    const handler = call![1];
    for (const senderFrame of [{}, null]) {
      handler({ senderFrame });
      expect(window?.restore).not.toHaveBeenCalled();
      expect(window?.show).not.toHaveBeenCalled();
      expect(window?.focus).not.toHaveBeenCalled();
    }
    handler({ senderFrame: window!.webContents.mainFrame });
    expect(window?.restore).toHaveBeenCalledOnce();
    expect(window?.show).toHaveBeenCalledOnce();
    expect(window?.focus).toHaveBeenCalledOnce();
    const fake = FakeBrowserWindow.instances[0]!;
    fake.isMinimized.mockReturnValue(false);
    handler({ senderFrame: window!.webContents.mainFrame });
    expect(window?.restore).toHaveBeenCalledOnce();
    expect(window?.focus).toHaveBeenCalledTimes(2);
    window?.destroy();
    handler({ senderFrame: window!.webContents.mainFrame });
    expect(window?.restore).toHaveBeenCalledOnce();
    expect(window?.show).toHaveBeenCalledTimes(2);
    expect(window?.focus).toHaveBeenCalledTimes(2);
  });
});
