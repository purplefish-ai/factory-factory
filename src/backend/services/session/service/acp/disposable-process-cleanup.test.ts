import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { terminateDisposableProcessTree } from './disposable-process-cleanup';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.execFile.mockReset();
  Object.defineProperty(process, 'platform', { value: 'win32' });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', platformDescriptor);
});

function createChild() {
  return Object.assign(new EventEmitter(), {
    pid: 424_242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
}

it('waits for direct-child exit after Windows taskkill completes', async () => {
  const child = createChild();
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
  let finished = false;
  const cleanup = terminateDisposableProcessTree(child as unknown as ChildProcess).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(finished).toBe(false);
  child.exitCode = 0;
  child.emit('exit');
  await cleanup;
  expect(child.listenerCount('exit')).toBe(0);
});

it('awaits the directly owned runtime after taskkill failure and fallback kill', async () => {
  const child = createChild();
  mocks.execFile.mockImplementation((_file, _args, _options, callback) =>
    callback(new Error('taskkill failed'))
  );
  let finished = false;
  const cleanup = terminateDisposableProcessTree(child as unknown as ChildProcess).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(finished).toBe(false);
  child.signalCode = 'SIGKILL';
  child.emit('exit');
  await cleanup;
});

it('reports unsuccessful Windows cleanup within five seconds and removes exit listeners', async () => {
  const child = createChild();
  mocks.execFile.mockImplementation((_file, _args, _options, callback) =>
    callback(new Error('taskkill failed'))
  );
  const cleanup = terminateDisposableProcessTree(child as unknown as ChildProcess);
  const rejected = expect(cleanup).rejects.toThrow('Disposable process cleanup failed');
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(child.listenerCount('exit')).toBe(0);
});
