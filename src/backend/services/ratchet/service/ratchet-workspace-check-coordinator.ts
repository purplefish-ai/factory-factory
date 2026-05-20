import type { WorkspaceRatchetResult, WorkspaceWithPR } from './ratchet.types';

export class RatchetWorkspaceCheckCoordinator {
  private readonly inFlightWorkspaceChecks = new Map<string, Promise<WorkspaceRatchetResult>>();

  constructor(private readonly getTimeoutMs: () => number) {}

  run(
    workspace: WorkspaceWithPR,
    runner: () => Promise<WorkspaceRatchetResult>
  ): Promise<WorkspaceRatchetResult> {
    const existing = this.inFlightWorkspaceChecks.get(workspace.id);
    if (existing) {
      return existing;
    }

    const inFlight = runner().finally(() => {
      if (this.inFlightWorkspaceChecks.get(workspace.id) === inFlight) {
        this.inFlightWorkspaceChecks.delete(workspace.id);
      }
    });
    this.inFlightWorkspaceChecks.set(workspace.id, inFlight);
    return this.withTimeout(workspace, inFlight);
  }

  private withTimeout(
    workspace: WorkspaceWithPR,
    checkPromise: Promise<WorkspaceRatchetResult>
  ): Promise<WorkspaceRatchetResult> {
    const timeoutMs = this.getTimeoutMs();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.inFlightWorkspaceChecks.get(workspace.id) === checkPromise) {
          this.inFlightWorkspaceChecks.delete(workspace.id);
        }
        reject(new Error(`Workspace check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();

      checkPromise.then(resolve, reject).finally(() => {
        clearTimeout(timeout);
      });
    });
  }
}
