import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { appGetPathMock } = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock,
  },
  utilityProcess: {
    fork: vi.fn(() => {
      throw new Error('tests must inject a utility process factory');
    }),
  },
}));

import {
  type BackendChildProcess,
  ServerManager,
  type ServerManagerOptions,
  type UtilityProcessFactory,
} from './server-manager.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_RESOURCES_PATH = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const RESOURCES_PATH = '/opt/Factory Factory/resources';

class FakeChild extends EventEmitter implements BackendChildProcess {
  static nextPid = 1000;
  readonly pid: number | undefined = FakeChild.nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);

  ready(url = 'http://localhost:4311'): void {
    this.emit('message', { type: 'ready', url });
  }

  exit(code: number): void {
    this.emit('exit', code);
  }
}

function setResourcesPath(resourcesPath: string): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
    writable: true,
  });
}

function restoreResourcesPath(): void {
  if (ORIGINAL_RESOURCES_PATH) {
    Object.defineProperty(process, 'resourcesPath', ORIGINAL_RESOURCES_PATH);
    return;
  }
  Reflect.deleteProperty(process, 'resourcesPath');
}

function createManager(options: Omit<ServerManagerOptions, 'utilityProcess'> = {}) {
  const children: FakeChild[] = [];
  const fork = vi.fn<UtilityProcessFactory['fork']>(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const killProcess = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
  const logger = { log: vi.fn(), error: vi.fn() };
  const manager = new ServerManager({
    utilityProcess: { fork },
    killProcess,
    logger,
    ...options,
  });
  // Children only exist after start() reaches fork(), which follows a lock await.
  const child = async (index = 0): Promise<FakeChild> => {
    await vi.waitFor(() => expect(children[index]).toBeDefined());
    return children[index] as FakeChild;
  };
  return { manager, fork, killProcess, logger, children, child };
}

async function startManager(harness: ReturnType<typeof createManager>, url?: string) {
  const startPromise = harness.manager.start();
  const child = await harness.child(harness.children.length);
  child.ready(url);
  return { url: await startPromise, child };
}

let userDataPath: string;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  Reflect.deleteProperty(process.env, 'VITE_DEV_SERVER_URL');
  setResourcesPath(RESOURCES_PATH);
  userDataPath = mkdtempSync(join(tmpdir(), 'ff-server-manager-'));
  appGetPathMock.mockReset();
  appGetPathMock.mockReturnValue(userDataPath);
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
  restoreResourcesPath();
  rmSync(userDataPath, { recursive: true, force: true });
});

describe('ServerManager startup', () => {
  it('forks the unpacked backend entry with its configuration in the child env', async () => {
    const harness = createManager();
    const envBefore = { ...process.env };

    const { url } = await startManager(harness, 'http://localhost:4311');

    expect(url).toBe('http://localhost:4311');
    expect(harness.fork).toHaveBeenCalledTimes(1);
    const [modulePath, args, options] = harness.fork.mock.calls[0] ?? [];
    expect(modulePath).toBe(
      join(
        RESOURCES_PATH,
        'app.asar.unpacked',
        'dist',
        'src',
        'backend',
        'electron-utility-entry.js'
      )
    );
    expect(args).toEqual([]);
    expect(options).toMatchObject({
      stdio: 'pipe',
      serviceName: 'Factory Factory Backend',
      env: {
        DATABASE_PATH: join(userDataPath, 'data.db'),
        MIGRATIONS_PATH: join(RESOURCES_PATH, 'prisma', 'migrations'),
        FRONTEND_STATIC_PATH: join(RESOURCES_PATH, 'app.asar.unpacked', 'dist', 'client'),
        WS_LOGS_PATH: join(userDataPath, 'ws-logs'),
        NODE_ENV: 'production',
        FF_NODE_EXEC_PATH: process.execPath,
      },
    });
    // The backend configuration goes to the child only.
    expect(process.env).toEqual(envBefore);
  });

  it('returns the Vite dev server URL without forking a backend', async () => {
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173';
    const harness = createManager();

    await expect(harness.manager.start()).resolves.toBe('http://localhost:5173');
    expect(harness.fork).not.toHaveBeenCalled();
  });

  it('rejects with the backend error message and kills the child', async () => {
    const harness = createManager();
    const startPromise = harness.manager.start();
    const child = await harness.child();

    // The child stays alive after reporting the error until main kills it.
    harness.killProcess.mockImplementation(() => child.exit(137));
    child.emit('message', { type: 'error', message: 'Error: migration 42 failed' });

    await expect(startPromise).rejects.toThrow('migration 42 failed');
    expect(harness.killProcess).toHaveBeenCalledWith(child.pid, 'SIGKILL');

    // The failed backend is forgotten, so the next start forks a new one.
    await startManager(harness);
    expect(harness.fork).toHaveBeenCalledTimes(2);
  });

  it('rejects when the backend exits before it is ready', async () => {
    const harness = createManager();
    const startPromise = harness.manager.start();
    const child = await harness.child();

    child.exit(3);

    await expect(startPromise).rejects.toThrow('exited with code 3 before it was ready');
    expect(harness.killProcess).not.toHaveBeenCalled();
  });

  it('kills a backend that does not become ready in time', async () => {
    const harness = createManager({ startTimeoutMs: 20 });
    const startPromise = harness.manager.start();
    const child = await harness.child();
    harness.killProcess.mockImplementation(() => child.exit(137));

    await expect(startPromise).rejects.toThrow('did not start within 20ms');
    expect(harness.killProcess).toHaveBeenCalledWith(child.pid, 'SIGKILL');
  });

  it('ignores malformed messages while waiting for ready', async () => {
    const harness = createManager();
    const startPromise = harness.manager.start();
    const child = await harness.child();

    child.emit('message', { type: 'ready' });
    child.emit('message', 'ready');
    child.ready('http://localhost:4400');

    await expect(startPromise).resolves.toBe('http://localhost:4400');
    expect(harness.logger.error).toHaveBeenCalledTimes(2);
  });

  it('forwards backend stdout and stderr lines to the logger', async () => {
    const harness = createManager();
    const { child } = await startManager(harness);

    child.stdout.write('first line\nsecond ');
    child.stdout.write('line\n');
    child.stderr.write('warning\n');

    await vi.waitFor(() => {
      expect(harness.logger.log).toHaveBeenCalledWith('[backend] first line');
      expect(harness.logger.log).toHaveBeenCalledWith('[backend] second line');
      expect(harness.logger.error).toHaveBeenCalledWith('[backend] warning');
    });
  });
});

describe('ServerManager shutdown', () => {
  it('asks the backend to shut down and waits for it to exit', async () => {
    const harness = createManager();
    const { child } = await startManager(harness);

    const stopPromise = harness.manager.stop();
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledWith({ type: 'shutdown' }));
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    child.exit(0);
    await stopPromise;
    expect(harness.killProcess).not.toHaveBeenCalled();
  });

  it('force-kills a backend that does not exit within the stop timeout', async () => {
    const harness = createManager({ stopTimeoutMs: 20 });
    const { child } = await startManager(harness);
    harness.killProcess.mockImplementation(() => child.exit(137));

    await expect(harness.manager.stop()).rejects.toThrow('did not exit within 20ms');
    expect(harness.killProcess).toHaveBeenCalledWith(child.pid, 'SIGKILL');

    // The killed backend is forgotten, so the next start forks a new one.
    await startManager(harness);
    expect(harness.fork).toHaveBeenCalledTimes(2);
  });

  it('reports a failing exit code but still forgets the backend', async () => {
    const harness = createManager();
    const { child } = await startManager(harness);

    const stopPromise = harness.manager.stop();
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalled());
    child.exit(1);

    await expect(stopPromise).rejects.toThrow('exited with code 1 during shutdown');
    await startManager(harness);
    expect(harness.fork).toHaveBeenCalledTimes(2);
  });

  it('cancels a start in flight instead of waiting for it to become ready', async () => {
    const harness = createManager();
    const startPromise = harness.manager.start();
    const child = await harness.child();

    const stopPromise = harness.manager.stop();
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'shutdown' });
    child.exit(0);

    await expect(startPromise).rejects.toThrow('startup was cancelled');
    await expect(stopPromise).resolves.toBeUndefined();
    expect(harness.killProcess).not.toHaveBeenCalled();
  });

  it('does not hand out the URL of a backend whose startup was cancelled', async () => {
    const harness = createManager();
    const startPromise = harness.manager.start();
    const child = await harness.child();

    const stopPromise = harness.manager.stop();
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'shutdown' });
    // The backend finished starting just as the shutdown request was sent, so
    // its ready message arrives before it handles the shutdown and exits.
    child.ready();
    child.exit(0);

    await expect(startPromise).rejects.toThrow('startup was cancelled');
    await expect(stopPromise).resolves.toBeUndefined();
    expect(harness.killProcess).not.toHaveBeenCalled();
  });

  it('kills a starting backend that ignores the cancel request', async () => {
    const harness = createManager({ stopTimeoutMs: 20 });
    const startPromise = harness.manager.start();
    const child = await harness.child();
    harness.killProcess.mockImplementation(() => child.exit(137));

    const stopPromise = harness.manager.stop();

    await expect(startPromise).rejects.toThrow('startup was cancelled');
    await expect(stopPromise).resolves.toBeUndefined();
    expect(harness.killProcess).toHaveBeenCalledWith(child.pid, 'SIGKILL');
  });

  it('does nothing when no backend is running', async () => {
    const harness = createManager();

    await expect(harness.manager.stop()).resolves.toBeUndefined();
  });
});

describe('ServerManager unexpected exits', () => {
  it('notifies listeners when a started backend exits on its own', async () => {
    const harness = createManager();
    const listener = vi.fn();
    harness.manager.onUnexpectedExit(listener);
    const { child } = await startManager(harness);

    child.exit(9);

    expect(listener).toHaveBeenCalledWith({ code: 9 });
    const { url } = await startManager(harness, 'http://localhost:5000');
    expect(url).toBe('http://localhost:5000');
    expect(harness.fork).toHaveBeenCalledTimes(2);
  });

  it('does not notify listeners for a requested stop or a failed start', async () => {
    const harness = createManager();
    const listener = vi.fn();
    harness.manager.onUnexpectedExit(listener);

    const { child } = await startManager(harness);
    const stopPromise = harness.manager.stop();
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalled());
    child.exit(0);
    await stopPromise;

    const failedStart = harness.manager.start();
    (await harness.child(1)).exit(1);
    await expect(failedStart).rejects.toThrow();

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying a listener after it unsubscribes', async () => {
    const harness = createManager();
    const listener = vi.fn();
    const unsubscribe = harness.manager.onUnexpectedExit(listener);
    const { child } = await startManager(harness);

    unsubscribe();
    child.exit(9);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ServerManager lifecycle locking', () => {
  it('reuses a single startup when start is called concurrently', async () => {
    const harness = createManager();

    const firstStart = harness.manager.start();
    const secondStart = harness.manager.start();
    (await harness.child()).ready('http://localhost:4100');

    await expect(Promise.all([firstStart, secondStart])).resolves.toEqual([
      'http://localhost:4100',
      'http://localhost:4100',
    ]);
    expect(harness.fork).toHaveBeenCalledTimes(1);
  });

  it('returns the cached URL when start is called after already started', async () => {
    const harness = createManager();
    await startManager(harness, 'http://localhost:4100');

    await expect(harness.manager.start()).resolves.toBe('http://localhost:4100');
    expect(harness.fork).toHaveBeenCalledTimes(1);
  });

  it('serializes stop and start so a new backend is not clobbered', async () => {
    const harness = createManager();
    const { child: first } = await startManager(harness, 'http://localhost:4100');

    const stopPromise = harness.manager.stop();
    const restartPromise = harness.manager.start();
    await vi.waitFor(() => expect(first.postMessage).toHaveBeenCalled());
    expect(harness.fork).toHaveBeenCalledTimes(1);

    first.exit(0);
    await stopPromise;
    const second = await harness.child(1);
    second.ready('http://localhost:4200');

    await expect(restartPromise).resolves.toBe('http://localhost:4200');
    expect(harness.fork).toHaveBeenCalledTimes(2);
  });
});
