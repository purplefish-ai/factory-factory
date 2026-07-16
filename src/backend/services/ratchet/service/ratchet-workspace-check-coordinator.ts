import type { WorkspaceRatchetResult, WorkspaceWithPR } from './ratchet.types';

interface InFlightWorkspaceCheck {
  controller: AbortController;
  promise: Promise<WorkspaceRatchetResult>;
}

export class RatchetWorkspaceCheckCoordinator {
  private readonly inFlightWorkspaceChecks = new Map<string, InFlightWorkspaceCheck>();

  constructor(private readonly getTimeoutMs: () => number) {}

  run(
    workspace: WorkspaceWithPR,
    runner: (signal: AbortSignal) => Promise<WorkspaceRatchetResult>
  ): Promise<WorkspaceRatchetResult> {
    const existing = this.inFlightWorkspaceChecks.get(workspace.id);
    if (existing) {
      return this.withTimeout(existing);
    }

    const controller = new AbortController();
    let inFlight!: InFlightWorkspaceCheck;
    const promise = runner(controller.signal).finally(() => {
      if (this.inFlightWorkspaceChecks.get(workspace.id) === inFlight) {
        this.inFlightWorkspaceChecks.delete(workspace.id);
      }
    });
    inFlight = { controller, promise };
    this.inFlightWorkspaceChecks.set(workspace.id, inFlight);
    return this.withTimeout(inFlight);
  }

  private withTimeout(inFlight: InFlightWorkspaceCheck): Promise<WorkspaceRatchetResult> {
    const timeoutMs = this.getTimeoutMs();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const timeoutError = new Error(`Workspace check timed out after ${timeoutMs}ms`);
        inFlight.controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
      timeout.unref?.();

      inFlight.promise.then(resolve, reject).finally(() => {
        clearTimeout(timeout);
      });
    });
  }
}
