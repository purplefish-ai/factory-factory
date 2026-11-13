import './run-script-legacy.test-support';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  spawnOwnedPostRun,
  FakeChildProcess,
  createExecutionOwner,
  mockTreeKill,
  mockFindById,
  mockCompleteStopping,
  mockMarkCompleted,
  mockMarkFailed,
  mockStopTunnel,
  MockRunScriptStateMachineError,
} from './run-script-legacy.test-support';

describe('RunScriptExecution.observeExit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => callback(null)
    );
  });

  it('finalizes STOPPING state to IDLE when the process exits', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STOPPING' });
    mockCompleteStopping.mockResolvedValue(undefined);

    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;

    await execution.observeExit(0, null);

    expect(mockFindById).toHaveBeenCalledWith('ws-1');
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('retries completeStopping persistence failures for STOPPING exits', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STOPPING' });
    let attempts = 0;
    mockCompleteStopping.mockImplementation(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('database unavailable'))
        : Promise.resolve(undefined);
    });

    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;

    await execution.observeExit(1, 'SIGTERM');

    expect(mockCompleteStopping).toHaveBeenCalledTimes(2);
    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('ignores stale process exits when a newer process is tracked', async () => {
    const owner = createExecutionOwner();
    const activeProcess = { pid: 22_222 };
    const listener = vi.fn();
    owner.replace(activeProcess);
    owner.runOutput.subscribe('ws-1', listener);

    const staleProcess = { pid: 11_111 };
    const staleExecution = owner.replace(staleProcess);
    owner.replace(activeProcess);
    await staleExecution.observeExit(0, null);
    owner.runOutput.append('ws-1', 'still subscribed');

    expect(owner.current()?.process).toBe(activeProcess);
    expect(listener).toHaveBeenCalledWith('still subscribed');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  it('ignores an untracked old exit while a new generation is starting', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STARTING' });
    const owner = createExecutionOwner({ pid: 11_111 });
    const execution = owner.execution;
    owner.discard();

    await execution.observeExit(0, null);

    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });
});

describe('RunScriptExecution.observeExit edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks COMPLETED on exit code 0 from RUNNING state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkCompleted.mockResolvedValue(undefined);

    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;
    await execution.observeExit(0, null);

    expect(mockMarkCompleted).toHaveBeenCalledWith('ws-1');
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('marks FAILED on non-zero exit code from RUNNING state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkFailed.mockResolvedValue(undefined);

    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;
    await execution.observeExit(1, null);

    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('marks FAILED on signal-killed process (null exit code)', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkFailed.mockResolvedValue(undefined);

    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;
    await execution.observeExit(null, 'SIGKILL');

    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
  });

  it('skips transition when already in IDLE state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'IDLE' });

    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;
    await execution.observeExit(0, null);

    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockCompleteStopping).not.toHaveBeenCalled();
  });

  it('skips transition when already in COMPLETED state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'COMPLETED' });

    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;
    await execution.observeExit(0, null);

    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('skips transition when already in FAILED state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'FAILED' });

    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;
    await execution.observeExit(1, null);

    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('retries a database failure before persisting a successful exit', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkCompleted
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(undefined);
    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner();
    const execution = owner.replace(childProcess);

    await execution.observeExit(0, null);

    expect(mockMarkCompleted).toHaveBeenCalledTimes(2);
    expect(Boolean(owner.current())).toBe(false);
  });

  it('escalates exhausted database failures and retains lifecycle evidence', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkFailed.mockRejectedValue(new Error('database unavailable'));
    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner();
    const listener = vi.fn();
    const execution = owner.replace(childProcess);
    await spawnOwnedPostRun(execution, new FakeChildProcess(888));
    owner.runOutput.subscribe('ws-1', listener);

    await expect(execution.observeExit(1, null)).rejects.toThrow('database unavailable');
    owner.runOutput.append('ws-1', 'still retained');

    expect(mockMarkFailed).toHaveBeenCalledTimes(3);
    expect(owner.current()?.process).toBe(childProcess);
    expect(mockTreeKill).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith('still retained');
    await execution.killPostRunProcess();
    expect(mockTreeKill).toHaveBeenCalledWith(888, 'SIGTERM', expect.any(Function));
  });

  it('recognizes a durable terminal state after a post-write error', async () => {
    mockFindById
      .mockResolvedValueOnce({ id: 'ws-1', runScriptStatus: 'RUNNING' })
      .mockResolvedValueOnce({ id: 'ws-1', runScriptStatus: 'COMPLETED' });
    mockMarkCompleted.mockRejectedValueOnce(new Error('post-write fetch failed'));
    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;

    await execution.observeExit(0, null);

    expect(mockMarkCompleted).toHaveBeenCalledTimes(1);
    expect(mockFindById).toHaveBeenCalledTimes(2);
  });

  it('stops retrying persistence when a new generation takes ownership', async () => {
    const exitingProcess = { pid: 12_345 };
    const newerProcess = { pid: 54_321 };
    const owner = createExecutionOwner();
    const execution = owner.replace(exitingProcess);
    mockFindById
      .mockResolvedValueOnce({ id: 'ws-1', runScriptStatus: 'RUNNING' })
      .mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STARTING' });
    mockMarkCompleted.mockImplementationOnce(() => {
      owner.replace(newerProcess);
      return Promise.reject(new Error('post-write fetch failed'));
    });

    await execution.observeExit(0, null);

    expect(mockMarkCompleted).toHaveBeenCalledTimes(1);
    expect(mockFindById).toHaveBeenCalledTimes(1);
    expect(owner.current()?.process).toBe(newerProcess);
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  it('accepts a state-machine race only after confirming a terminal state', async () => {
    mockFindById
      .mockResolvedValueOnce({ id: 'ws-1', runScriptStatus: 'RUNNING' })
      .mockResolvedValueOnce({ id: 'ws-1', runScriptStatus: 'COMPLETED' });
    mockMarkCompleted.mockRejectedValue(
      new MockRunScriptStateMachineError('ws-1', 'COMPLETED', 'COMPLETED')
    );

    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;

    await expect(execution.observeExit(0, null)).resolves.toBeUndefined();

    expect(mockFindById).toHaveBeenCalledTimes(2);
    expect(mockMarkCompleted).toHaveBeenCalledTimes(1);
  });

  it('escalates a state-machine error when refreshed state remains active', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkCompleted.mockRejectedValue(
      new MockRunScriptStateMachineError('ws-1', 'RUNNING', 'COMPLETED')
    );

    const childProcess = { pid: 12_345 };
    const owner = createExecutionOwner(childProcess);
    const execution = owner.execution;

    await expect(execution.observeExit(0, null)).rejects.toThrow(MockRunScriptStateMachineError);

    expect(mockMarkCompleted).toHaveBeenCalledTimes(3);
    expect(mockFindById).toHaveBeenCalledTimes(6);
  });

  it('does not clean up a newer process that starts while exit persistence is pending', async () => {
    let resolveTransition: (() => void) | undefined;
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkCompleted.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTransition = resolve;
        })
    );
    const exitingProcess = { pid: 12_345 };
    const newerProcess = { pid: 54_321 };
    const owner = createExecutionOwner();
    const execution = owner.replace(exitingProcess);

    const exitPromise = execution.observeExit(0, null);
    await vi.waitFor(() => expect(resolveTransition).toBeDefined());
    owner.replace(newerProcess);
    resolveTransition?.();
    await exitPromise;

    expect(owner.current()?.process).toBe(newerProcess);
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  it('does not stop a newer tunnel when ownership changes during postRun cleanup', async () => {
    let completeTreeKill: ((error: Error | null) => void) | undefined;
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkCompleted.mockResolvedValue(undefined);
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => {
        completeTreeKill = callback;
      }
    );
    const exitingProcess = { pid: 12_345 };
    const newerProcess = { pid: 54_321 };
    const owner = createExecutionOwner();
    const execution = owner.replace(exitingProcess);
    await spawnOwnedPostRun(execution, new FakeChildProcess(888));

    const exitPromise = execution.observeExit(0, null);
    await vi.waitFor(() => expect(completeTreeKill).toBeDefined());
    owner.replace(newerProcess);
    completeTreeKill?.(null);
    await exitPromise;

    expect(owner.current()?.process).toBe(newerProcess);
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });
});
