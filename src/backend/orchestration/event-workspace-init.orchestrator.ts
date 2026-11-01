import { toError } from '@/backend/lib/error-utils';
import { pathExists } from '@/backend/lib/file-helpers';
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
  workspaceDataService,
  type EventWorkspaceClaim,
} from '@/backend/services/workspace';
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
    };
export type EventWorkspaceInitializationInput = {
  claim: EventWorkspaceClaim;
  signal: AbortSignal;
  /** Caller owns live-task fencing; owner transactions independently check durable generation. */
  assertCurrent?: () => void;
  beforeReady?: () => Promise<void>;
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
  private readonly timer: ReturnType<typeof setTimeout>;
  private fenceLost = false;
  private candidate?: { path: string; project: EventWorkspace['project'] };
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
    try {
      this.input.assertCurrent?.();
    } catch (error) {
      this.fenceLost = true;
      throw error;
    }
  };
  private current = async () => {
    this.check();
    try {
      return await eventWorkspaceInitService.read(this.input.claim, this.check);
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
        if (!(await pathExists(existing.worktreePath))) {
          throw new Error('Event worktree is unavailable');
        }
        await this.current();
        return this.ready(existing.initErrorMessage ?? undefined);
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
  private async provision(workspace: EventWorkspace) {
    // Abort never abandons Git's promise; its late result is owned until cleanup drains.
    const tree = await resolveWorkspaceWorktree({
      workspaceWithProject: workspace,
      worktreeName: `workspace-${workspace.id}`,
      baseBranch: workspace.project.defaultBranch,
      useExistingBranch: false,
    });
    if (tree.created) {
      this.candidate = { path: tree.worktreePath, project: workspace.project };
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
        assertCurrent: this.current,
        appendOutput: (text) => eventWorkspaceInitService.appendOutput(claim, text, this.check),
        setPid: (pid) => eventWorkspaceInitService.scriptPid(claim, pid, false, this.check),
        clearPid: (pid) => eventWorkspaceInitService.scriptPid(claim, pid, true),
      }
    );
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
    const initialCleanup = cause instanceof EventSetupError ? cause.cleanup : 'CONFIRMED';
    const cleanup = await this.cleanupCandidate(initialCleanup);
    const error = toError(cause);
    const status = this.failureStatus(error);
    if (status !== 'STALE') {
      try {
        await eventWorkspaceInitService.finish(this.input.claim, 'FAILED', error.message);
      } catch {
        /* A superseded/deleted owner must not be overwritten. */
      }
    }
    return { status, cleanup, reason: error.message.slice(0, 2000) };
  }
  private async cleanupCandidate(cleanup: Cleanup): Promise<Cleanup> {
    if (!this.candidate || this.registered) {
      return cleanup;
    }
    try {
      const live = await workspaceDataService.findById(this.input.claim.reservedWorkspaceId);
      if (live?.worktreePath) {
        return cleanup;
      }
      if (this.fenceLost) {
        return 'UNKNOWN';
      }
      await assertWorktreePathSafe(this.candidate.path, this.candidate.project.worktreeBasePath);
      await gitOpsService.removeWorktree(this.candidate.path, this.candidate.project);
      return cleanup;
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
