import './run-script-legacy.test-support';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeChildProcess,
  createExecutionOwner,
  flushMicrotasks,
  mockMarkFailed,
  mockSpawn,
  mockTreeKill,
} from './run-script-legacy.test-support';

describe('RunScriptExecution process events', () => {
  it('captures stdout/stderr output and handles spawn errors', async () => {
    const owner = createExecutionOwner();
    const child = new FakeChildProcess(12_345);
    mockSpawn.mockReturnValue(child);
    owner.execution.spawn('echo main', '/tmp/ws-1');
    child.stdout.emit('data', Buffer.from('stdout chunk'));
    child.stderr.emit('data', Buffer.from('stderr chunk'));
    child.stdout.emit('error', new Error('stdout stream failed'));
    child.stderr.emit('error', new Error('stderr stream failed'));
    child.emit('error', new Error('spawn failed'));
    await flushMicrotasks();
    expect(owner.output).toHaveBeenNthCalledWith(1, 'stdout chunk');
    expect(owner.output).toHaveBeenNthCalledWith(2, 'stderr chunk');
    expect(owner.current()).toBeUndefined();
    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
  });

  it('swallows markFailed errors from spawn error handler', async () => {
    mockMarkFailed.mockRejectedValue(new Error('state moved'));
    const owner = createExecutionOwner();
    const child = new FakeChildProcess(12_345);
    mockSpawn.mockReturnValue(child);
    owner.execution.spawn('echo main', '/tmp/ws-1');
    child.emit('error', new Error('spawn failed'));
    await flushMicrotasks();
    expect(owner.current()).toBeUndefined();
    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
  });

  it('ignores a late spawn error from a replaced process', async () => {
    const owner = createExecutionOwner();
    const child = new FakeChildProcess(12_345);
    mockSpawn.mockReturnValue(child);
    owner.execution.spawn('echo main', '/tmp/ws-1');
    const replacement = new FakeChildProcess(54_321);
    owner.replace(replacement);
    child.emit('error', new Error('late spawn failure'));
    await flushMicrotasks();
    expect(owner.current()?.process).toBe(replacement);
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('swallows exit-handler failures when observeExit rejects', async () => {
    const owner = createExecutionOwner();
    const child = new FakeChildProcess(12_345);
    mockSpawn.mockReturnValue(child);
    const observeExit = vi
      .spyOn(owner.execution, 'observeExit')
      .mockRejectedValue(new Error('exit handler failed'));
    owner.execution.spawn('echo main', '/tmp/ws-1');
    child.emit('exit', 1, 'SIGTERM');
    await flushMicrotasks();
    expect(observeExit).toHaveBeenCalledWith(1, 'SIGTERM');
  });
});

describe('RunScriptExecution.killProcessTree', () => {
  it('returns when killProcessTree has no target pid', async () => {
    await expect(createExecutionOwner().execution.killProcessTree(null)).resolves.toBeUndefined();
    expect(mockTreeKill).not.toHaveBeenCalled();
  });

  it('retains process ownership after ESRCH until the stop flow releases it', async () => {
    const error = Object.assign(new Error('No such process'), { code: 'ESRCH' });
    mockTreeKill.mockImplementation((_pid, _signal, callback) => callback(error));
    const running = new FakeChildProcess(12_345);
    const owner = createExecutionOwner(running);
    await owner.execution.killProcessTree(null);
    expect(owner.current()?.process).toBe(running);
    expect(owner.execution.observation.kind).toBe('live');
  });

  it('does not delete a replacement process after the previous tree-kill completes', async () => {
    let complete!: (error: Error | null) => void;
    mockTreeKill.mockImplementation((_pid, _signal, callback) => {
      complete = callback;
    });
    const owner = createExecutionOwner(new FakeChildProcess(12_345));
    const kill = owner.execution.killProcessTree(null);
    const replacement = new FakeChildProcess(54_321);
    owner.replace(replacement);
    complete(null);
    await kill;
    expect(owner.current()?.process).toBe(replacement);
  });
});
describe('RunScriptExecution.waitForProcessExit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns immediately when no process is provided', async () => {
    await expect(
      createExecutionOwner().execution.waitForProcessExit(12_345)
    ).resolves.toBeUndefined();
  });

  it('returns when process already has exitCode', async () => {
    const childProcess = new FakeChildProcess(12_345);
    childProcess.exitCode = 0;

    await expect(
      createExecutionOwner(childProcess).execution.waitForProcessExit(12_345)
    ).resolves.toBeUndefined();
  });

  it('returns when process already has signalCode', async () => {
    const childProcess = new FakeChildProcess(12_345);
    childProcess.signalCode = 'SIGTERM';
    const onceSpy = vi.spyOn(childProcess, 'once');

    await expect(
      createExecutionOwner(childProcess).execution.waitForProcessExit(12_345)
    ).resolves.toBeUndefined();
    expect(onceSpy).not.toHaveBeenCalled();
  });

  it('returns when child process does not expose once/off', async () => {
    await expect(
      createExecutionOwner({ pid: 12_345, exitCode: null }).execution.waitForProcessExit(12_345)
    ).resolves.toBeUndefined();
  });

  it('resolves when wait listener receives process error event', async () => {
    const childProcess = new FakeChildProcess(12_345);

    const waitPromise = createExecutionOwner(childProcess).execution.waitForProcessExit(12_345);
    childProcess.emit('error', new Error('process stream error'));
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('resolves on timeout while waiting for process exit', async () => {
    vi.useFakeTimers();
    const childProcess = new FakeChildProcess(12_345);

    const waitPromise = createExecutionOwner(childProcess).execution.waitForProcessExit(12_345);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(waitPromise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('resolves immediately when exitCode flips after listeners are attached', async () => {
    const childProcess = new FakeChildProcess(12_345);
    const onceSpy = vi.spyOn(childProcess, 'once');
    onceSpy.mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      EventEmitter.prototype.once.call(childProcess, event, listener);
      childProcess.exitCode = 0;
      return childProcess;
    }) as typeof childProcess.once);

    await expect(
      createExecutionOwner(childProcess).execution.waitForProcessExit(12_345)
    ).resolves.toBeUndefined();
  });

  it('resolves immediately when signalCode flips after listeners are attached', async () => {
    const childProcess = new FakeChildProcess(12_345);
    const onceSpy = vi.spyOn(childProcess, 'once');
    onceSpy.mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      EventEmitter.prototype.once.call(childProcess, event, listener);
      childProcess.signalCode = 'SIGTERM';
      return childProcess;
    }) as typeof childProcess.once);

    await expect(
      createExecutionOwner(childProcess).execution.waitForProcessExit(12_345)
    ).resolves.toBeUndefined();
  });
});
