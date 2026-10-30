import { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { stopChild } from './child-lifecycle';
import { treeKillAsync } from './runtime-utils';

vi.mock('./runtime-utils', () => ({ treeKillAsync: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('escalates a backend that ignores SIGTERM instead of leaking it', async () => {
  vi.useFakeTimers();
  const backend = Object.assign(new ChildProcess(), { pid: 4321 });
  vi.mocked(treeKillAsync).mockResolvedValue();
  const stopping = stopChild(backend);
  await vi.advanceTimersByTimeAsync(4999);
  expect(treeKillAsync).toHaveBeenCalledExactlyOnceWith(4321, 'SIGTERM');
  await vi.advanceTimersByTimeAsync(1);
  await stopping;
  expect(treeKillAsync).toHaveBeenLastCalledWith(4321, 'SIGKILL');
  expect(backend.listenerCount('exit')).toBe(0);
  expect(backend.listenerCount('error')).toBe(0);
});

it('does not escalate a child that exits gracefully', async () => {
  const backend = Object.assign(new ChildProcess(), { pid: 4321 });
  vi.mocked(treeKillAsync).mockImplementation(() => {
    backend.emit('exit', 0, null);
    return Promise.resolve();
  });
  await stopChild(backend);
  expect(treeKillAsync).toHaveBeenCalledExactlyOnceWith(4321, 'SIGTERM');
  expect(backend.listenerCount('exit')).toBe(0);
});
