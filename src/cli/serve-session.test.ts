import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { treeKillAsync, waitForPort } from './runtime-utils';
import { runServeSession } from './serve-session';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(true) }));
vi.mock('./runtime-utils', () => ({ treeKillAsync: vi.fn(), waitForPort: vi.fn() }));

let backend: ChildProcess;
let frontend: ChildProcess;
function exit(child: ChildProcess, code = 0, signal: NodeJS.Signals | null = null) {
  Object.defineProperty(child, 'exitCode', { value: signal ? null : code, configurable: true });
  Object.defineProperty(child, 'signalCode', { value: signal, configurable: true });
  child.emit('exit', child.exitCode, signal);
}
const onReady = vi.fn<() => Promise<void>>();
const options = {
  projectRoot: '/project',
  env: { TEST_ENV: 'kept' },
  host: '127.0.0.1',
  frontendPort: 3000,
  backendPort: 3001,
  dev: true,
  verbose: true,
  onReady,
};
beforeEach(() => {
  vi.mocked(existsSync).mockReturnValue(true);
  backend = Object.assign(new ChildProcess(), { pid: 4321 });
  frontend = Object.assign(new ChildProcess(), { pid: 4322 });
  vi.mocked(spawn).mockReturnValueOnce(backend).mockReturnValueOnce(frontend);
  vi.mocked(waitForPort).mockResolvedValue();
  vi.mocked(treeKillAsync).mockImplementation((pid) => {
    exit(pid === backend.pid ? backend : frontend, 0, 'SIGTERM');
    return Promise.resolve();
  });
  onReady.mockResolvedValue();
  vi.spyOn(console, 'log').mockImplementation(() => {
    /* Keep expected startup logs quiet. */
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each([0, 2])(
  'stops the sibling when the backend unexpectedly exits with code %s',
  async (code) => {
    const session = runServeSession({ ...options, signal: new AbortController().signal });
    const failed = expect(session).rejects.toThrow(/Backend.*exited/);
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
    exit(backend, code);
    await failed;
    expect(treeKillAsync).toHaveBeenCalledExactlyOnceWith(4322, 'SIGTERM');
    expect(backend.listenerCount('exit')).toBe(0);
    expect(frontend.listenerCount('error')).toBe(0);
  }
);

it('handles a spawn error before readiness and cancels readiness polling', async () => {
  Object.defineProperty(backend, 'pid', { value: undefined, configurable: true });
  let readinessCancelled = false;
  vi.mocked(waitForPort).mockImplementation(
    (_port, _host, _timeout, _interval, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            readinessCancelled = true;
            reject(signal.reason);
          },
          { once: true }
        );
      })
  );
  const session = runServeSession({ ...options, signal: new AbortController().signal });
  const failed = expect(session).rejects.toThrow(/Backend.*ENOENT/);
  backend.emit('error', new Error('ENOENT'));
  await failed;
  expect(onReady).not.toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(readinessCancelled).toBe(true);
});

it('never starts the frontend after an early backend exit, even if readiness resolves later', async () => {
  let ready = () => {
    /* Replaced by the readiness resolver. */
  };
  vi.mocked(waitForPort).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      })
  );
  const session = runServeSession({ ...options, signal: new AbortController().signal });
  const failed = expect(session).rejects.toThrow(/Backend.*exited/);
  exit(backend);
  await failed;
  ready();
  await Promise.resolve();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(onReady).not.toHaveBeenCalled();
});

it('cleans up both children when readiness fails', async () => {
  vi.mocked(waitForPort).mockResolvedValueOnce().mockRejectedValueOnce(new Error('not listening'));
  await expect(
    runServeSession({ ...options, signal: new AbortController().signal })
  ).rejects.toThrow('not listening');
  expect(treeKillAsync).toHaveBeenCalledWith(4321, 'SIGTERM');
  expect(treeKillAsync).toHaveBeenCalledWith(4322, 'SIGTERM');
  expect(onReady).not.toHaveBeenCalled();
});

it('observes exits while the browser is still opening', async () => {
  onReady.mockImplementation(
    () =>
      new Promise(() => {
        /* Intentionally pending readiness/browser work. */
      })
  );
  const session = runServeSession({ ...options, signal: new AbortController().signal });
  const failed = expect(session).rejects.toThrow(/Frontend.*exited/);
  await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
  exit(frontend);
  await failed;
  expect(treeKillAsync).toHaveBeenCalledExactlyOnceWith(4321, 'SIGTERM');
});

it('joins graceful shutdown during startup without starting the frontend', async () => {
  const controller = new AbortController();
  vi.mocked(waitForPort).mockImplementation(
    () =>
      new Promise(() => {
        /* Intentionally pending readiness/browser work. */
      })
  );
  const session = runServeSession({ ...options, signal: controller.signal });
  controller.abort();
  await session;
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(treeKillAsync).toHaveBeenCalledExactlyOnceWith(4321, 'SIGTERM');
  expect(onReady).not.toHaveBeenCalled();
});

it('bounds sibling cleanup after a crash and escalates a child that ignores SIGTERM', async () => {
  vi.useFakeTimers();
  vi.mocked(treeKillAsync).mockResolvedValue();
  const session = runServeSession({ ...options, signal: new AbortController().signal });
  const failed = expect(session).rejects.toThrow(/Backend.*exited/);
  await vi.advanceTimersByTimeAsync(0);
  exit(backend, 2);
  await vi.advanceTimersByTimeAsync(4999);
  expect(treeKillAsync).toHaveBeenCalledExactlyOnceWith(4322, 'SIGTERM');
  await vi.advanceTimersByTimeAsync(1);
  await failed;
  expect(treeKillAsync).toHaveBeenLastCalledWith(4322, 'SIGKILL');
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves development commands, environment and readiness ports', async () => {
  const controller = new AbortController();
  const session = runServeSession({ ...options, signal: controller.signal });
  await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
  expect(spawn).toHaveBeenNthCalledWith(
    1,
    '/project/node_modules/.bin/tsx',
    ['watch', 'src/backend/index.ts'],
    { cwd: '/project', env: { TEST_ENV: 'kept' }, stdio: 'inherit' }
  );
  expect(spawn).toHaveBeenNthCalledWith(
    2,
    '/project/node_modules/.bin/vite',
    ['--port', '3000', '--strictPort'],
    {
      cwd: '/project',
      env: { TEST_ENV: 'kept', BACKEND_URL: 'http://127.0.0.1:3001' },
      stdio: 'inherit',
    }
  );
  expect(waitForPort).toHaveBeenNthCalledWith(
    1,
    3001,
    '127.0.0.1',
    undefined,
    undefined,
    expect.any(AbortSignal)
  );
  expect(waitForPort).toHaveBeenNthCalledWith(
    2,
    3000,
    '127.0.0.1',
    undefined,
    undefined,
    expect.any(AbortSignal)
  );
  controller.abort();
  await session;
});

it('starts the compiled production server with static assets and one readiness check', async () => {
  const controller = new AbortController();
  const session = runServeSession({ ...options, dev: false, signal: controller.signal });
  await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
  expect(spawn).toHaveBeenCalledExactlyOnceWith('node', ['/project/dist/src/backend/index.js'], {
    cwd: '/project',
    env: { TEST_ENV: 'kept', FRONTEND_STATIC_PATH: '/project/dist/client' },
    stdio: 'inherit',
  });
  expect(waitForPort).toHaveBeenCalledTimes(1);
  controller.abort();
  await session;
});

it('detects an already exited child returned by spawn before advertising readiness', async () => {
  Object.defineProperty(backend, 'exitCode', { value: 0, configurable: true });
  await expect(
    runServeSession({ ...options, signal: new AbortController().signal })
  ).rejects.toThrow(/Backend.*exited/);
  expect(onReady).not.toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(treeKillAsync).not.toHaveBeenCalled();
});

it('does not spawn after cancellation before startup', async () => {
  const controller = new AbortController();
  controller.abort();
  await runServeSession({ ...options, signal: controller.signal });
  expect(spawn).not.toHaveBeenCalled();
  expect(onReady).not.toHaveBeenCalled();
});

it('cleans up the backend if spawning the frontend throws synchronously', async () => {
  vi.mocked(spawn)
    .mockReset()
    .mockReturnValueOnce(backend)
    .mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
  await expect(
    runServeSession({ ...options, signal: new AbortController().signal })
  ).rejects.toThrow('spawn failed');
  expect(treeKillAsync).toHaveBeenCalledExactlyOnceWith(4321, 'SIGTERM');
});

it('exposes an IPC backend to the update supervisor and accepts its expected exit', async () => {
  let expectedExit = false;
  const connected = vi.fn();
  const session = runServeSession({
    ...options,
    dev: false,
    signal: new AbortController().signal,
    onBackend: connected,
    isExpectedBackendExit: () => expectedExit,
  });
  await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
  expect(connected).toHaveBeenCalledWith(backend);
  expect(vi.mocked(spawn).mock.calls[0]?.[2]?.stdio).toEqual([
    'inherit',
    'inherit',
    'inherit',
    'ipc',
  ]);
  expectedExit = true;
  exit(backend);
  await expect(session).resolves.toBeUndefined();
});
