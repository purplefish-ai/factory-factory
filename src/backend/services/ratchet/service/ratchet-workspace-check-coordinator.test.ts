import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRatchetResult, WorkspaceWithPR } from './ratchet.types';
import { RatchetWorkspaceCheckCoordinator } from './ratchet-workspace-check-coordinator';

describe('RatchetWorkspaceCheckCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the workspace timeout to reused in-flight checks', async () => {
    const coordinator = new RatchetWorkspaceCheckCoordinator(() => 1000);
    const workspace = { id: 'workspace-1' } as WorkspaceWithPR;
    const runner = vi.fn(
      () =>
        new Promise<WorkspaceRatchetResult>(() => {
          // Keep the underlying check stalled so each caller must rely on its timeout.
        })
    );

    const firstRun = coordinator.run(workspace, runner);
    const secondRun = coordinator.run(workspace, runner);

    expect(runner).toHaveBeenCalledTimes(1);

    const firstExpectation = expect(firstRun).rejects.toThrow(
      'Workspace check timed out after 1000ms'
    );
    const secondExpectation = expect(secondRun).rejects.toThrow(
      'Workspace check timed out after 1000ms'
    );

    await vi.advanceTimersByTimeAsync(1000);

    await firstExpectation;
    await secondExpectation;
  });

  it('aborts the shared runner when a workspace check times out', async () => {
    const coordinator = new RatchetWorkspaceCheckCoordinator(() => 1000);
    const workspace = { id: 'workspace-abort' } as WorkspaceWithPR;
    let receivedSignal: AbortSignal | undefined;
    const runner = vi.fn((signal?: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<WorkspaceRatchetResult>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    const firstRun = coordinator.run(workspace, runner);
    const secondRun = coordinator.run(workspace, runner);
    const firstExpectation = expect(firstRun).rejects.toThrow(
      'Workspace check timed out after 1000ms'
    );
    const secondExpectation = expect(secondRun).rejects.toThrow(
      'Workspace check timed out after 1000ms'
    );

    await vi.advanceTimersByTimeAsync(1000);

    await firstExpectation;
    await secondExpectation;
    expect(runner).toHaveBeenCalledTimes(1);
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toEqual(new Error('Workspace check timed out after 1000ms'));
  });

  it('keeps sharing an aborted runner until its cleanup settles', async () => {
    const coordinator = new RatchetWorkspaceCheckCoordinator(() => 1000);
    const workspace = { id: 'workspace-cleanup' } as WorkspaceWithPR;
    let finishCleanup!: () => void;
    const cleanupBarrier = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const runner = vi.fn(async (signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await cleanupBarrier;
      signal.throwIfAborted();
      throw new Error('unreachable');
    });

    const first = coordinator.run(workspace, runner);
    const firstExpectation = expect(first).rejects.toThrow(
      'Workspace check timed out after 1000ms'
    );
    await vi.advanceTimersByTimeAsync(1000);
    await firstExpectation;

    const joinedDuringCleanup = coordinator.run(workspace, runner);
    expect(runner).toHaveBeenCalledTimes(1);
    finishCleanup();

    await expect(joinedDuringCleanup).rejects.toThrow('Workspace check timed out after 1000ms');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('starts the timeout only after the scheduler starts the runner', async () => {
    const coordinator = new RatchetWorkspaceCheckCoordinator(() => 1000);
    const workspace = { id: 'workspace-queued' } as WorkspaceWithPR;
    let startScheduledRunner!: () => void;
    const schedule = vi.fn(
      (task: () => Promise<WorkspaceRatchetResult>) =>
        new Promise<WorkspaceRatchetResult>((resolve, reject) => {
          startScheduledRunner = () => {
            task().then(resolve, reject);
          };
        })
    );
    const runner = vi.fn(
      (signal: AbortSignal) =>
        new Promise<WorkspaceRatchetResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );

    const result = coordinator.run(workspace, runner, schedule);
    await vi.advanceTimersByTimeAsync(5000);

    expect(runner).not.toHaveBeenCalled();
    startScheduledRunner();
    const expectation = expect(result).rejects.toThrow('Workspace check timed out after 1000ms');
    await vi.advanceTimersByTimeAsync(1000);

    await expectation;
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
