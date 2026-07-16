import type { WorkspaceRatchetResult, WorkspaceWithPR } from './ratchet.types';

interface InFlightWorkspaceCheck {
  controller: AbortController;
  promise: Promise<WorkspaceRatchetResult> | null;
  started: Promise<void>;
  timeoutDisabled: boolean;
}

type WorkspaceCheckScheduler = (
  task: () => Promise<WorkspaceRatchetResult>
) => Promise<WorkspaceRatchetResult>;

const runImmediately: WorkspaceCheckScheduler = (task) => task();

export class RatchetWorkspaceCheckCoordinator {
  private readonly inFlightWorkspaceChecks = new Map<string, InFlightWorkspaceCheck>();

  constructor(private readonly getTimeoutMs: () => number) {}

  run(
    workspace: WorkspaceWithPR,
    runner: (signal: AbortSignal, commitSideEffects: () => void) => Promise<WorkspaceRatchetResult>,
    schedule: WorkspaceCheckScheduler = runImmediately
  ): Promise<WorkspaceRatchetResult> {
    const existing = this.inFlightWorkspaceChecks.get(workspace.id);
    if (existing) {
      return this.withTimeout(existing);
    }

    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const inFlight: InFlightWorkspaceCheck = {
      controller,
      promise: null,
      started,
      timeoutDisabled: false,
    };
    const promise = schedule(async () => {
      markStarted();
      controller.signal.throwIfAborted();
      return await runner(controller.signal, () => {
        inFlight.timeoutDisabled = true;
      });
    }).finally(() => {
      if (this.inFlightWorkspaceChecks.get(workspace.id) === inFlight) {
        this.inFlightWorkspaceChecks.delete(workspace.id);
      }
    });
    inFlight.promise = promise;
    this.inFlightWorkspaceChecks.set(workspace.id, inFlight);
    return this.withTimeout(inFlight);
  }

  private async withTimeout(inFlight: InFlightWorkspaceCheck): Promise<WorkspaceRatchetResult> {
    await inFlight.started;
    const promise = inFlight.promise;
    if (!promise) {
      throw new Error('Workspace check started without a scheduled promise');
    }
    const timeoutMs = this.getTimeoutMs();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (inFlight.timeoutDisabled) {
          return;
        }
        const timeoutError = new Error(`Workspace check timed out after ${timeoutMs}ms`);
        inFlight.controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
      timeout.unref?.();

      promise.then(resolve, reject).finally(() => {
        clearTimeout(timeout);
      });
    });
  }
}
