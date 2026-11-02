import { stat } from 'node:fs/promises';
import { toError } from '@/backend/lib/error-utils';
import { SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import {
  FactoryConfigService,
  EventSetupError,
  runScriptConfigPersistenceService,
  startupScriptService,
} from '@/backend/services/run-script';
import { sessionDomainService } from '@/backend/services/session';
import {
  assertWorktreePathSafe,
  eventWorkspaceInitService,
  EventWorkspaceFenceError,
  gitOpsService,
  type EventWorkspaceClaim,
} from '@/backend/services/workspace';
import { classifyEventPreparationFailure } from '@/shared/event-agent-preparation';
import {
  enqueueWorkspaceInitializationTask,
  resolveWorkspaceWorktree,
} from './workspace-init.orchestrator';

export type EventWorkspaceInitializationResult =
  | { status: 'READY'; workspaceId: string; sessionId: string; warning?: string }
  | {
      status: 'FAILED' | 'ABORTED' | 'TIMED_OUT' | 'STALE';
      cleanup: 'CONFIRMED' | 'UNKNOWN';
      reason: string;
      failure: ReturnType<typeof classifyEventPreparationFailure>;
    };
export type EventWorkspaceInitializationInput = {
  claim: EventWorkspaceClaim;
  signal: AbortSignal;
  /** Caller owns live-task fencing; owner transactions independently check durable generation. */
  assertCurrent?: () => void;
  beforeReady?: () => Promise<void>;
  /** Actual physical operations only; durable reads/publication are separately bounded. */
  physicalStage?: (active: boolean) => void;
  /** Original durable setup deadline; a READY worktree needs no physical setup retry. */
  deadlineAt?: number;
};
type EventWorkspace = Awaited<ReturnType<typeof eventWorkspaceInitService.read>>;
type Worktree = Awaited<ReturnType<typeof resolveWorkspaceWorktree>>;
type Cleanup = 'CONFIRMED' | 'UNKNOWN';

export function initializeEventWorkspaceWorktree(
  input: EventWorkspaceInitializationInput
): Promise<EventWorkspaceInitializationResult> {
  return enqueueWorkspaceInitializationTask(input.claim.reservedWorkspaceId, () =>
    new EventWorkspaceInitialization(input).run()
  );
}
/** One owned operation inside the shared workspace initializer tail. */
class EventWorkspaceInitialization {
  private readonly timeout = new AbortController();
  private readonly signal: AbortSignal;
  private timer: ReturnType<typeof setTimeout>;
  private fenceLost = false;
  private candidate?: {
    path: string;
    project: EventWorkspace['project'];
    owned: boolean;
    canonicalBasePath: string;
  };
  private registered = false;
  private releaseInitial?: () => void;
  constructor(private readonly input: EventWorkspaceInitializationInput) {
    this.signal = AbortSignal.any([input.signal, this.timeout.signal]);
    this.timer = setTimeout(
      () => this.timeout.abort(new DOMException('Event setup timed out', 'TimeoutError')),
      SERVICE_TIMEOUT_MS.eventWorkspaceSetup
    );
  }
  private check = () => {
    this.signal.throwIfAborted();
    this.assertOwned();
  };
  private assertOwned = () => {
    try {
      this.input.assertCurrent?.();
    } catch (error) {
      this.fenceLost = true;
      throw error;
    }
  };
  private current = async (check = this.check) => {
    check();
    try {
      const workspace = await eventWorkspaceInitService.read(this.input.claim, check);
      check();
      return workspace;
    } catch (error) {
      if (error instanceof EventWorkspaceFenceError) {
        this.fenceLost = true;
      }
      throw error;
    }
  };
  async run(): Promise<EventWorkspaceInitializationResult> {
    try {
      const existing = await this.current();
      if (existing.status === 'READY' && existing.worktreePath) {
        if (await isWorktreeMissing(existing.worktreePath)) {
          await eventWorkspaceInitService.invalidateMissingWorktree(
            this.input.claim,
            existing.worktreePath,
            this.check
          );
          throw new Error('Event worktree is unavailable');
        }
        await this.current();
        return this.ready(existing.initErrorMessage ?? undefined);
      }
      if (this.input.deadlineAt !== undefined) {
        clearTimeout(this.timer);
        const remaining = this.input.deadlineAt - Date.now();
        const expire = () =>
          this.timeout.abort(new DOMException('Event setup timed out', 'TimeoutError'));
        if (remaining <= 0) {
          expire();
        } else {
          this.timer = setTimeout(expire, remaining);
        }
        this.check();
      }
      await eventWorkspaceInitService.start(this.input.claim, this.check);
      const workspace = await this.current();
      const warning = await this.provision(workspace);
      await this.current();
      this.releaseInitial = sessionDomainService.beginInitialLaunch(
        this.input.claim.reservedSessionId
      );
      await this.input.beforeReady?.();
      await eventWorkspaceInitService.finish(this.input.claim, 'READY', warning, this.check);
      return this.ready(warning);
    } catch (cause) {
      return await this.failed(cause);
    } finally {
      clearTimeout(this.timer);
      this.releaseInitial?.();
    }
  }
  private ready(warning?: string): EventWorkspaceInitializationResult {
    return {
      status: 'READY',
      workspaceId: this.input.claim.reservedWorkspaceId,
      sessionId: this.input.claim.reservedSessionId,
      ...(warning ? { warning } : {}),
    };
  }
  private async physical<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOwned();
    this.input.physicalStage?.(true);
    try {
      return await operation();
    } finally {
      this.input.physicalStage?.(false);
    }
  }
  private async provision(workspace: EventWorkspace) {
    const worktreeName = `workspace-${workspace.id}`;
    if (!workspace.worktreePath) {
      const prepared = await this.physical(() =>
        gitOpsService.prepareWorktreeCreation(workspace.project, worktreeName)
      );
      this.candidate = {
        path: prepared.worktreePath,
        canonicalBasePath: prepared.canonicalBasePath,
        project: workspace.project,
        owned: false,
      };
      await this.current();
    }
    // Abort never abandons Git's promise; its late result is owned until cleanup drains.
    const tree = await this.physical(() =>
      resolveWorkspaceWorktree({
        workspaceWithProject: workspace,
        worktreeName,
        baseBranch: workspace.project.defaultBranch,
        useExistingBranch: false,
      })
    );
    if (tree.created && this.candidate) {
      this.candidate = { ...this.candidate, path: tree.worktreePath, owned: true };
    }
    await this.current();
    const config = await FactoryConfigService.readConfig(tree.worktreePath);
    await this.current();
    await runScriptConfigPersistenceService.syncWorkspaceCommandsFromFactoryConfig({
      workspaceId: workspace.id,
      factoryConfig: config,
      persistWorkspaceCommands: (_id, commands) =>
        eventWorkspaceInitService.register(
          this.input.claim,
          {
            worktreePath: tree.worktreePath,
            branchName: tree.branchName,
            isAutoGeneratedBranch: tree.created || workspace.isAutoGeneratedBranch,
          },
          commands,
          this.check
        ),
    });
    this.registered = true;
    const phases = startupProjects(workspace.project, config);
    let warning: string | undefined;
    for (const project of phases) {
      await this.current();
      const result = await this.script(workspace, project, tree);
      if (!result.success) {
        warning = result.errorMessage;
      }
    }
    return warning;
  }
  private script(workspace: EventWorkspace, project: EventWorkspace['project'], tree: Worktree) {
    const { claim } = this.input;
    return startupScriptService.runEventStartupScript(
      { ...workspace, worktreePath: tree.worktreePath },
      project,
      {
        signal: this.signal,
        physicalStage: this.input.physicalStage,
        assertCurrent: this.current,
        appendOutput: (text) => eventWorkspaceInitService.appendOutput(claim, text, this.check),
        setPid: (pid) => eventWorkspaceInitService.scriptPid(claim, pid, false, this.check),
        clearPid: (pid) => this.clearScriptPid(pid),
      }
    );
  }
  private async clearScriptPid(pid: number) {
    try {
      this.assertOwned();
      await eventWorkspaceInitService.scriptPid(this.input.claim, pid, true, this.assertOwned);
    } catch (error) {
      if (error instanceof EventWorkspaceFenceError) {
        this.fenceLost = true;
      }
      throw error;
    }
  }
  private failureStatus(error: Error) {
    if (this.fenceLost || error instanceof EventWorkspaceFenceError) {
      return 'STALE';
    }
    if (error instanceof EventSetupError) {
      return error.kind;
    }
    if (this.signal.aborted) {
      return this.timeout.signal.aborted ? 'TIMED_OUT' : 'ABORTED';
    }
    return 'FAILED';
  }
  private async failed(cause: unknown): Promise<EventWorkspaceInitializationResult> {
    try {
      this.assertOwned();
    } catch {
      this.fenceLost = true;
    }
    const initialCleanup = cause instanceof EventSetupError ? cause.cleanup : 'CONFIRMED';
    const cleanup = await this.cleanupCandidate(initialCleanup);
    const error = toError(cause);
    const status = this.failureStatus(error);
    if (status !== 'STALE' && cleanup === 'CONFIRMED') {
      try {
        await eventWorkspaceInitService.finish(
          this.input.claim,
          'FAILED',
          error.message,
          this.assertOwned
        );
      } catch {
        /* A superseded/deleted owner must not be overwritten. */
      }
    }
    return {
      status,
      cleanup,
      reason: error.message.slice(0, 2000),
      failure:
        cause instanceof EventSetupError ? cause.failure : classifyEventPreparationFailure(cause),
    };
  }
  private async cleanupCandidate(cleanup: Cleanup): Promise<Cleanup> {
    if (!this.candidate || this.registered) {
      return cleanup;
    }
    try {
      if (this.candidate.owned) {
        await assertWorktreePathSafe(this.candidate.path, this.candidate.project.worktreeBasePath);
      }
      // Cancellation does not revoke ownership; a takeover or expired lease does.
      const live = await this.current(this.assertOwned);
      if (live.worktreePath) {
        return 'UNKNOWN';
      }
      if (!this.candidate.owned) {
        const absent = await gitOpsService.confirmWorktreeAbsent(
          this.candidate.path,
          this.candidate.project,
          this.candidate.canonicalBasePath
        );
        await this.current(this.assertOwned);
        return absent ? cleanup : 'UNKNOWN';
      }
      const candidate = this.candidate;
      await this.physical(() => gitOpsService.removeWorktree(candidate.path, candidate.project));
      const absent = await gitOpsService.confirmWorktreeAbsent(
        this.candidate.path,
        this.candidate.project,
        this.candidate.canonicalBasePath
      );
      await this.current(this.assertOwned);
      return absent ? cleanup : 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }
}
function startupProjects(
  project: EventWorkspace['project'],
  config: Awaited<ReturnType<typeof FactoryConfigService.readConfig>>
) {
  const phases: EventWorkspace['project'][] = config?.scripts.setup
    ? [{ ...project, startupScriptCommand: config.scripts.setup, startupScriptPath: null }]
    : [];
  if (startupScriptService.hasStartupScript(project)) {
    phases.push(project);
  }
  return phases;
}

async function isWorktreeMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}
