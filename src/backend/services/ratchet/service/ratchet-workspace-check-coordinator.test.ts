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
});
