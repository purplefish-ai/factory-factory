import type { ChildProcess } from 'node:child_process';
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
