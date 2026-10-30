import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { terminateDisposableProcessTree } from './owned-process-cleanup';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function child() {
  return Object.assign(new EventEmitter(), {
    pid: 424_242,
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  });
}
it.skipIf(process.platform === 'win32')(
  'escalates a surviving process group and confirms exit inside its cleanup budget',
  async () => {
    vi.useFakeTimers();
    let alive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (!alive) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGKILL') {
        alive = false;
      }
      return true;
    });
    const cleanup = terminateDisposableProcessTree(child() as unknown as ChildProcess, {
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
    expect(kill).toHaveBeenCalledWith(-424_242, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-424_242, 'SIGKILL');
    expect(alive).toBe(false);
  }
);
it.skipIf(process.platform === 'win32')(
  'reports failed process-group cleanup within the caller budget',
  async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const cleanup = terminateDisposableProcessTree(child() as unknown as ChildProcess, {
      timeoutMs: 100,
    });
    const rejected = expect(cleanup).rejects.toThrow('Disposable process cleanup failed');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  }
);
it.skipIf(process.platform === 'win32')(
  'waits through EPERM while an exited process group is still being reaped',
  async () => {
    vi.useFakeTimers();
    let reaped = false;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      // macOS reports EPERM for a process group whose members exited but are not yet reaped.
      throw Object.assign(new Error(reaped ? 'gone' : 'zombie'), {
        code: reaped ? 'ESRCH' : 'EPERM',
      });
    });
    let settled = false;
    const cleanup = terminateDisposableProcessTree(child() as unknown as ChildProcess, {
      timeoutMs: 1000,
    }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    reaped = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(cleanup).resolves.toBeUndefined();
  }
);
it.skipIf(process.platform === 'win32')(
  'reports cleanup failure when EPERM persists past the caller budget',
  async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    let settled = false;
    const cleanup = terminateDisposableProcessTree(child() as unknown as ChildProcess, {
      timeoutMs: 100,
    }).finally(() => {
      settled = true;
    });
    const rejected = expect(cleanup).rejects.toThrow('Disposable process cleanup failed');
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
  }
);
it.skipIf(process.platform === 'win32')(
  'cleans up a real child that exited before the event loop could reap it',
  async () => {
    const exited = spawn('true', [], { detached: true, stdio: 'ignore' });
    // Simulate a busy server: the child exits while the event loop is blocked.
    const until = Date.now() + 200;
    while (Date.now() < until) {
      // busy wait
    }
    await expect(
      terminateDisposableProcessTree(exited, { timeoutMs: 2000 })
    ).resolves.toBeUndefined();
  }
);
