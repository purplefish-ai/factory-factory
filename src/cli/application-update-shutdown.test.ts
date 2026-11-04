import { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { stopBackendForUpdate } from './application-update-shutdown';
afterEach(() => vi.useRealTimers());
function child() {
  return Object.assign(new ChildProcess(), { kill: vi.fn(() => true) });
}
it.each(['exit', 'close'] as const)(
  'never escalates after observing %s termination',
  async (event) => {
    vi.useFakeTimers();
    const process = child();
    const stopped = stopBackendForUpdate(process, 100);
    process.emit(event, 0, null);
    await stopped;
    await vi.advanceTimersByTimeAsync(1000);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  }
);
it('only escalates while the child has no observed exit or terminal code', async () => {
  vi.useFakeTimers();
  const process = child();
  const stopped = stopBackendForUpdate(process, 100);
  Object.defineProperty(process, 'exitCode', { value: 0 });
  await vi.advanceTimersByTimeAsync(100);
  expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  process.emit('close', 0, null);
  await stopped;
});
it('escalates a backend that remains alive and waits for termination before rejecting', async () => {
  vi.useFakeTimers();
  const process = child();
  const stopped = stopBackendForUpdate(process, 100);
  const rejected = expect(stopped).rejects.toThrow('Backend shutdown failed');
  await vi.advanceTimersByTimeAsync(100);
  expect(process.kill).toHaveBeenLastCalledWith('SIGKILL');
  process.emit('exit', null, 'SIGKILL');
  await rejected;
});
