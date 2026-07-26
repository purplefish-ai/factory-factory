import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { runTestCommand } from './test-runner.service';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

describe('runTestCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a natural exit at the timeout boundary as successful', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runTestCommand('/tmp/worktree', 'pnpm test', 1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
  });

  it('reports a process terminated by the timeout signal as timed out', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockReturnValue(true);
    mockSpawn.mockReturnValue(child);

    const resultPromise = runTestCommand('/tmp/worktree', 'pnpm test', 1);

    await vi.advanceTimersByTimeAsync(1000);
    child.emit('close', null, 'SIGTERM');

    await expect(resultPromise).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 1,
      timedOut: true,
    });
  });

  it('does not report a different termination signal as the test-runner timeout', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockReturnValue(true);
    mockSpawn.mockReturnValue(child);

    const resultPromise = runTestCommand('/tmp/worktree', 'pnpm test', 1);

    await vi.advanceTimersByTimeAsync(1000);
    child.emit('close', null, 'SIGINT');

    await expect(resultPromise).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 1,
      timedOut: false,
    });
  });

  it('does not report a timeout when killing the process emits an error', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runTestCommand('/tmp/worktree', 'pnpm test', 1);

    await vi.advanceTimersByTimeAsync(1000);
    child.emit('error', new Error('kill failed'));

    await expect(resultPromise).resolves.toEqual({
      stdout: '',
      stderr: '\nkill failed',
      exitCode: 1,
      timedOut: false,
    });
  });
});
