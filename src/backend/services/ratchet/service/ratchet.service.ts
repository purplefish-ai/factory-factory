import { EventEmitter } from 'node:events';
import type { RatchetDispatchOutcome, RatchetReviewTriggerMode } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { toError } from '@/backend/lib/error-utils';
import {
  SERVICE_INTERVAL_MS,
  SERVICE_THRESHOLDS,
  SERVICE_TIMEOUT_MS,
} from '@/backend/services/constants';
import { jobRunner } from '@/backend/services/job-runner.service';
import { createLogger } from '@/backend/services/logger.service';
import { RateLimitBackoff } from '@/backend/services/rate-limit-backoff';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService, workspaceRatchetService } from '@/backend/services/workspace';
import { CIStatus, RatchetState, SessionStatus } from '@/shared/core';
import type {
  RatchetGitHubBridge,
  RatchetPRSnapshotBridge,
  RatchetSessionBridge,
  RatchetWorkspaceBridge,
} from './bridges';
import type {
  ActiveFixerCheckResult,
  PRStateFetchResult,
  PRStateFetchSkipped,
  PRStateInfo,
  RatchetAction,
  RatchetCheckResult,
  RatchetDecision,
  RatchetDecisionContext,
  WorkspaceRatchetResult,
  WorkspaceWithPR,
} from './ratchet.types';
import {
  checkActiveFixerSession as checkActiveFixerSessionHelper,
  hasActiveSession as hasActiveSessionHelper,
} from './ratchet-active-session.helpers';
import { logWorkspaceRatchetingDecision as logWorkspaceRatchetingDecisionHelper } from './ratchet-decision-logging.helpers';
import { triggerRatchetFixer } from './ratchet-fixer-dispatch.helpers';
import type { AuthenticatedUsernameCache } from './ratchet-pr-state.helpers';
import {
  determineRatchetState as determineRatchetStateHelper,
  fetchPRState as fetchPRStateHelper,
  getAuthenticatedUsernameCached as getAuthenticatedUsernameCachedHelper,
  hasNewReviewActivitySinceLastDispatch as hasNewReviewActivitySinceLastDispatchHelper,
  isPRStateFetchSkipped,
  shouldSkipCleanPR as shouldSkipCleanPRHelper,
} from './ratchet-pr-state.helpers';
import {
  RatchetWorkspaceCheckCoordinator,
  type WorkspaceCheckScheduler,
} from './ratchet-workspace-check-coordinator';

const logger = createLogger('ratchet');
const RATCHET_WORKSPACE_CONCURRENCY = 3;
const ratchetWorkspaceLimit = pLimit(RATCHET_WORKSPACE_CONCURRENCY);
const scheduleRatchetBatchCheck: WorkspaceCheckScheduler = (task) => ratchetWorkspaceLimit(task);

const RECENTLY_FETCHED_REASON: PRStateFetchSkipped['reason'] = 'recently_fetched';

function isRecentlyFetchedWaitResult(result: WorkspaceRatchetResult): boolean {
  return result.action.type === 'WAITING' && result.action.reason === RECENTLY_FETCHED_REASON;
}

export type { RatchetAction, RatchetCheckResult, WorkspaceRatchetResult } from './ratchet.types';

export const RATCHET_STATE_CHANGED = 'ratchet_state_changed' as const;
export const RATCHET_TOGGLED = 'ratchet_toggled' as const;
export const RATCHET_DISPATCH_CHANGED = 'ratchet_dispatch_changed' as const;

export interface RatchetDispatchChangedEvent {
  workspaceId: string;
}

export interface RatchetStateChangedEvent {
  workspaceId: string;
  fromState: RatchetState;
  toState: RatchetState;
  /** Fresh CI status observed from GitHub during this ratchet poll. */
  prCiStatus?: CIStatus;
}

export interface RatchetToggledEvent {
  workspaceId: string;
  enabled: boolean;
  ratchetState: RatchetState;
}

export interface RatchetCheckOptions {
  /**
   * Fetch fresh PR state even if another service fetched this workspace's PR
   * within the dedup cooldown. Event-driven checks (PR switch, reopen) fire
   * right after the scheduler sync that emitted the event registered its own
   * fetch, so without the bypass they are guaranteed to be deduped into a
   * no-op and ratcheting would only resume on a later poll cycle.
   */
  bypassPrFetchCooldown?: boolean;
}

/** Job name this service registers with the shared runner. */
const RATCHET_POLL_JOB = 'ratchet-poll';

class RatchetService extends EventEmitter {
  /** The signal of the run currently executing; see `isShuttingDown`. */
  private runSignal: AbortSignal | null = null;
  /** Whether the service itself has been stopped, independent of any run. */
  private stopped = false;
  private workspaceCheckTimeoutMs = SERVICE_TIMEOUT_MS.ratchetWorkspaceCheck;
  private readonly checkCoordinator = new RatchetWorkspaceCheckCoordinator(
    () => this.workspaceCheckTimeoutMs
  );
  private cachedAuthenticatedUsername: AuthenticatedUsernameCache | null = null;
  private readonly backoff = new RateLimitBackoff();

  private sessionBridge: RatchetSessionBridge | null = null;
  private githubBridge: RatchetGitHubBridge | null = null;
  private snapshotBridge: RatchetPRSnapshotBridge | null = null;
  private workspaceBridge: RatchetWorkspaceBridge | null = null;

  constructor() {
    super();
    jobRunner.register({
      name: RATCHET_POLL_JOB,
      intervalMs: SERVICE_INTERVAL_MS.ratchetPoll,
      // The loop polled once before its first sleep, and still does.
      runImmediately: true,
      run: (signal) => this.runCycle(signal),
      computeDelay: (base) => this.nextPollDelay(base),
    });
  }

  /**
   * The service's own stopped state, or an abort on the run in flight. Both
   * are needed: `checkAllWorkspaces` and `checkWorkspaceById` are triggered on
   * demand by the admin router and the event collector and must respect a
   * shutdown that has already happened, while the signal is what lets a poll
   * already underway give up before checking the next workspace.
   */
  private get isShuttingDown(): boolean {
    return this.stopped || (this.runSignal?.aborted ?? false);
  }

  configure(bridges: {
    session: RatchetSessionBridge;
    github: RatchetGitHubBridge;
    snapshot: RatchetPRSnapshotBridge;
    workspace: RatchetWorkspaceBridge;
  }): void {
    this.sessionBridge = bridges.session;
    this.githubBridge = bridges.github;
    this.snapshotBridge = bridges.snapshot;
    this.workspaceBridge = bridges.workspace;
  }

  private get workspace(): RatchetWorkspaceBridge {
    if (!this.workspaceBridge) {
      throw new Error(
        'RatchetService not configured: workspace bridge missing. Call configure() first.'
      );
    }
    return this.workspaceBridge;
  }

  private get session(): RatchetSessionBridge {
    if (!this.sessionBridge) {
      throw new Error(
        'RatchetService not configured: session bridge missing. Call configure() first.'
      );
    }
    return this.sessionBridge;
  }

  private get github(): RatchetGitHubBridge {
    if (!this.githubBridge) {
      throw new Error(
        'RatchetService not configured: github bridge missing. Call configure() first.'
      );
    }
    return this.githubBridge;
  }

  private get snapshot(): RatchetPRSnapshotBridge {
    if (!this.snapshotBridge) {
      throw new Error(
        'RatchetService not configured: snapshot bridge missing. Call configure() first.'
      );
    }
    return this.snapshotBridge;
  }

  start(): void {
    this.stopped = false;
    jobRunner.start(RATCHET_POLL_JOB);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await jobRunner.stop(RATCHET_POLL_JOB);
  }

  /** One poll cycle, with the rate-limit backoff bookkeeping around it. */
  private async runCycle(signal: AbortSignal): Promise<void> {
    this.runSignal = signal;
    try {
      this.backoff.beginCycle();
      await this.checkAllWorkspaces();
      this.backoff.resetIfCleanCycle(logger, 'Ratchet');
    } catch (err) {
      logger.error('Ratchet check failed', toError(err));
    } finally {
      // Scoped to this run; see the note in `scheduler.service.ts`.
      this.runSignal = null;
    }
  }

  /** Stretch the poll interval while GitHub is rate-limiting us. */
  private nextPollDelay(baseIntervalMs: number): number {
    const delayMs = this.backoff.computeDelay(baseIntervalMs);
    if (this.backoff.currentMultiplier > 1) {
      logger.debug('Using backoff delay for next ratchet check', {
        baseIntervalMs,
        backoffMultiplier: this.backoff.currentMultiplier,
        delayMs,
      });
    }
    return delayMs;
  }

  async checkAllWorkspaces(): Promise<RatchetCheckResult> {
    if (this.isShuttingDown) {
      return { checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] };
    }

    const workspaces = await workspaceRatchetService.findCandidates();

    if (workspaces.length === 0) {
      return { checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] };
    }

    const userSettings = await userSettingsService.get();

    const results = await Promise.all(
      workspaces.map((workspace) =>
        this.runWorkspaceCheckSafely(
          workspace,
          undefined,
          scheduleRatchetBatchCheck,
          userSettings.ratchetReviewTriggerMode
        )
      )
    );

    const stateChanges = results.filter((r) => r.previousState !== r.newState).length;
    const actionsTriggered = results.filter((r) => r.action.type === 'TRIGGERED_FIXER').length;

    if (stateChanges > 0 || actionsTriggered > 0) {
      logger.info('Ratchet check completed', {
        checked: workspaces.length,
        stateChanges,
        actionsTriggered,
      });
    }

    return { checked: workspaces.length, stateChanges, actionsTriggered, results };
  }

  async checkWorkspaceById(
    workspaceId: string,
    opts?: RatchetCheckOptions
  ): Promise<WorkspaceRatchetResult | null> {
    if (this.isShuttingDown) {
      return null;
    }

    const workspace = await workspaceRatchetService.findCandidateById(workspaceId);
    if (!workspace) {
      return null;
    }

    const userSettings = await userSettingsService.get();
    const reviewTriggerMode = userSettings.ratchetReviewTriggerMode;

    const result = await this.runWorkspaceCheckSafely(
      workspace,
      opts,
      undefined,
      reviewTriggerMode
    );

    // A bypassed check can still come back dedup-skipped: the coordinator may
    // have joined a normal check that was already in flight, or another
    // service's fetch was actively in flight. Rerun once now that the
    // concurrent work has settled so the bypass actually applies.
    if (opts?.bypassPrFetchCooldown && isRecentlyFetchedWaitResult(result)) {
      const freshWorkspace = await workspaceRatchetService.findCandidateById(workspaceId);
      if (!freshWorkspace) {
        return result;
      }
      return this.runWorkspaceCheckSafely(freshWorkspace, opts, undefined, reviewTriggerMode);
    }

    return result;
  }

  /**
   * Settle the dispatch record when a fixer session ends. Conditional on the
   * pointer still naming the session, so a stale caller cannot overwrite an
   * outcome that was already recorded by another session-end path.
   */
  async recordSessionEnd(
    workspaceId: string,
    sessionId: string,
    outcome: Exclude<RatchetDispatchOutcome, 'RUNNING'>
  ): Promise<void> {
    const settled = await this.workspace.recordSessionEnd(workspaceId, sessionId, outcome);
    if (!settled) {
      return;
    }

    this.emit(RATCHET_DISPATCH_CHANGED, {
      workspaceId,
    } satisfies RatchetDispatchChangedEvent);
  }

  private async runWorkspaceCheckSafely(
    workspace: WorkspaceWithPR,
    opts?: RatchetCheckOptions,
    schedule?: WorkspaceCheckScheduler,
    reviewTriggerMode?: RatchetReviewTriggerMode
  ): Promise<WorkspaceRatchetResult> {
    try {
      return await this.checkCoordinator.run(
        workspace,
        (signal, commitSideEffects) => {
          signal.throwIfAborted();
          return this.processWorkspace(
            workspace,
            opts,
            signal,
            commitSideEffects,
            reviewTriggerMode
          );
        },
        schedule
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('Ratchet workspace check failed', {
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
        error: errorMessage,
      });
      return {
        workspaceId: workspace.id,
        previousState: workspace.ratchetState,
        newState: workspace.ratchetState,
        action: { type: 'ERROR', error: errorMessage },
      };
    }
  }

  async setWorkspaceRatcheting(workspaceId: string, enabled: boolean): Promise<void> {
    const workspace = await workspaceDataService.findById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    if (enabled) {
      await workspaceRatchetService.enable(workspaceId);
      this.emit(RATCHET_TOGGLED, {
        workspaceId,
        enabled: true,
        ratchetState: workspace.ratchetState,
      } satisfies RatchetToggledEvent);
      return;
    }

    await workspaceRatchetService.disable(workspaceId);

    // Stops every running ratchet-workflow session, including the one the
    // (now cleared) active-session pointer named.
    await this.stopActiveRatchetSessionsAfterDisable(workspaceId);

    // `disable` is the whole transition: `deriveRatchetState` reads IDLE for a
    // workspace that is not ratcheting, so there is no second write to settle and
    // no window in which the state disagrees with the toggle.
    if (workspace.ratchetState !== RatchetState.IDLE) {
      this.emit(RATCHET_STATE_CHANGED, {
        workspaceId,
        fromState: workspace.ratchetState,
        toState: RatchetState.IDLE,
      } satisfies RatchetStateChangedEvent);
    }

    this.emit(RATCHET_TOGGLED, {
      workspaceId,
      enabled: false,
      ratchetState: RatchetState.IDLE,
    } satisfies RatchetToggledEvent);
  }

  private async processWorkspace(
    workspace: WorkspaceWithPR,
    opts?: RatchetCheckOptions,
    signal: AbortSignal = new AbortController().signal,
    commitSideEffects: () => void = () => {
      // Direct private-method callers do not have a coordinator timeout to disable.
    },
    reviewTriggerMode?: RatchetReviewTriggerMode
  ): Promise<WorkspaceRatchetResult> {
    signal.throwIfAborted();
    if (this.isShuttingDown) {
      return {
        workspaceId: workspace.id,
        previousState: workspace.ratchetState,
        newState: workspace.ratchetState,
        action: { type: 'WAITING', reason: 'Shutting down' },
      };
    }

    if (!workspace.ratchetEnabled) {
      const action: RatchetAction = { type: 'DISABLED', reason: 'Workspace ratcheting disabled' };
      // Nothing to settle: a disabled workspace already derives to IDLE, so the
      // row this check read is the row every later read will project from. Which
      // also means `fromState` here is IDLE, and there is no transition to emit.
      const fromState = workspace.ratchetState;
      this.logWorkspaceRatchetingDecision(workspace, fromState, fromState, action, null);
      return {
        workspaceId: workspace.id,
        previousState: fromState,
        newState: fromState,
        action,
      };
    }

    try {
      signal.throwIfAborted();
      const effectiveReviewTriggerMode =
        reviewTriggerMode ?? (await userSettingsService.get()).ratchetReviewTriggerMode;
      signal.throwIfAborted();
      const authenticatedUsername = await this.getAuthenticatedUsernameCached(signal);
      signal.throwIfAborted();
      const prStateResult = await this.fetchPRState(
        workspace,
        authenticatedUsername,
        {
          bypassRecentFetchCooldown: opts?.bypassPrFetchCooldown,
          reviewTriggerMode: effectiveReviewTriggerMode,
        },
        signal
      );
      signal.throwIfAborted();
      if (isPRStateFetchSkipped(prStateResult)) {
        const action: RatchetAction = { type: 'WAITING', reason: prStateResult.reason };
        this.logWorkspaceRatchetingDecision(
          workspace,
          workspace.ratchetState,
          workspace.ratchetState,
          action,
          null
        );
        return {
          workspaceId: workspace.id,
          previousState: workspace.ratchetState,
          newState: workspace.ratchetState,
          action,
        };
      }

      if (!prStateResult) {
        const action: RatchetAction = { type: 'ERROR', error: 'Failed to fetch PR state' };
        this.logWorkspaceRatchetingDecision(
          workspace,
          workspace.ratchetState,
          workspace.ratchetState,
          action,
          null
        );
        return {
          workspaceId: workspace.id,
          previousState: workspace.ratchetState,
          newState: workspace.ratchetState,
          action,
        };
      }

      const prStateInfo = prStateResult;
      signal.throwIfAborted();
      if (prStateInfo.prState === 'MERGED') {
        await this.stopActiveRatchetSessionsForMergedPr(workspace.id, signal);
        signal.throwIfAborted();
      }
      const decisionContext = await this.buildRatchetDecisionContext(
        workspace,
        prStateInfo,
        signal
      );
      signal.throwIfAborted();
      const decision = await this.decideRatchetAction(decisionContext, signal);
      signal.throwIfAborted();
      const action = await this.applyRatchetDecision(
        decisionContext,
        decision,
        signal,
        commitSideEffects
      );
      signal.throwIfAborted();

      return await this.finishRatchetCheck(workspace, prStateInfo, action, decisionContext, signal);
    } catch (error) {
      signal.throwIfAborted();
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error processing workspace in ratchet', toError(error), {
        workspaceId: workspace.id,
      });
      const action: RatchetAction = { type: 'ERROR', error: errorMessage };
      this.logWorkspaceRatchetingDecision(
        workspace,
        workspace.ratchetState,
        workspace.ratchetState,
        action,
        null
      );
      return {
        workspaceId: workspace.id,
        previousState: workspace.ratchetState,
        newState: workspace.ratchetState,
        action,
      };
    }
  }

  private logWorkspaceRatchetingDecision(
    workspace: WorkspaceWithPR,
    previousState: RatchetState,
    newState: RatchetState,
    action: RatchetAction,
    prStateInfo: PRStateInfo | null,
    decisionContext: RatchetDecisionContext | null = null
  ): void {
    logWorkspaceRatchetingDecisionHelper({
      workspace,
      previousState,
      newState,
      action,
      prStateInfo,
      decisionContext,
    });
  }

  private async buildRatchetDecisionContext(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    signal: AbortSignal = new AbortController().signal
  ): Promise<RatchetDecisionContext> {
    const previousState = workspace.ratchetState;
    const newState = determineRatchetStateHelper(prStateInfo);
    const hasNewReviewActivitySinceLastDispatch = hasNewReviewActivitySinceLastDispatchHelper(
      workspace,
      prStateInfo
    );
    const hasStateChangedSinceLastDispatch = this.hasStateChangedSinceLastDispatch(
      workspace,
      prStateInfo
    );
    const isCleanPrWithNoNewReviewActivity = shouldSkipCleanPRHelper(workspace, prStateInfo);

    // ratchetEnabled is guaranteed here: the poll query filters on it and
    // processWorkspace returns early for disabled workspaces.
    const activeFixerCheck: ActiveFixerCheckResult =
      prStateInfo.prState === 'OPEN'
        ? await this.checkActiveFixerSession(workspace, signal)
        : { kind: 'none' };
    signal.throwIfAborted();

    // The check above may have just settled a RUNNING record (e.g. to DIED);
    // use the settled outcome rather than the row read at the start of the check.
    const dispatchOutcome =
      activeFixerCheck.kind === 'settled'
        ? activeFixerCheck.outcome
        : workspace.ratchetDispatchOutcome;

    return {
      workspace,
      prStateInfo,
      previousState,
      newState,
      hasNewReviewActivitySinceLastDispatch,
      hasStateChangedSinceLastDispatch,
      isCleanPrWithNoNewReviewActivity,
      activeFixerCheck,
      dispatchOutcome,
      dispatchRetryCount: workspace.ratchetDispatchRetryCount,
    };
  }

  private async decideRatchetAction(
    context: RatchetDecisionContext,
    signal: AbortSignal = new AbortController().signal
  ): Promise<RatchetDecision> {
    signal.throwIfAborted();
    if (context.prStateInfo.prState === 'MERGED') {
      return { type: 'RETURN_ACTION', action: { type: 'COMPLETED' } };
    }

    if (context.prStateInfo.prState !== 'OPEN') {
      return {
        type: 'RETURN_ACTION',
        action: { type: 'WAITING', reason: 'PR is not open' },
      };
    }

    const isTerminalCIStatus =
      context.prStateInfo.ciStatus === CIStatus.SUCCESS ||
      context.prStateInfo.ciStatus === CIStatus.FAILURE;

    if (!(isTerminalCIStatus || context.prStateInfo.hasMergeConflict)) {
      return {
        type: 'RETURN_ACTION',
        action: { type: 'WAITING', reason: 'Waiting for CI to complete (not in terminal state)' },
      };
    }

    if (context.activeFixerCheck.kind === 'active') {
      return { type: 'RETURN_ACTION', action: context.activeFixerCheck.action };
    }

    if (context.activeFixerCheck.kind === 'ended_concurrently') {
      return {
        type: 'RETURN_ACTION',
        action: {
          type: 'WAITING',
          reason: 'Fixer session ended during this check; re-evaluating next cycle',
        },
      };
    }

    // A fixer that died gets re-dispatched for the same PR state (bounded),
    // ahead of the skip gates below — the original dispatch already
    // established that this PR state warrants a fixer.
    if (!context.hasStateChangedSinceLastDispatch && context.dispatchOutcome === 'DIED') {
      return this.decideDiedFixerRetry(context, signal);
    }

    if (context.isCleanPrWithNoNewReviewActivity) {
      return {
        type: 'RETURN_ACTION',
        action: { type: 'WAITING', reason: 'PR is clean (green CI and no new review activity)' },
      };
    }

    if (!this.hasActionableFixTrigger(context.prStateInfo)) {
      return {
        type: 'RETURN_ACTION',
        action: { type: 'WAITING', reason: 'No CI failures or PR review comments to address' },
      };
    }

    if (!context.hasStateChangedSinceLastDispatch) {
      // A settled dispatch achieved nothing for this PR state, and this gate is
      // only reachable after an actionable trigger was confirmed and the DIED
      // and active-session paths returned. Nothing further will happen here
      // until the PR changes, so record it rather than looking busy.
      await this.recordDispatchStalled(context);
      return {
        type: 'RETURN_ACTION',
        action: { type: 'WAITING', reason: 'PR state unchanged since last ratchet dispatch' },
      };
    }

    // Fetched lazily as the last gate so the common no-op path issues no
    // session query.
    signal.throwIfAborted();
    if (await this.hasActiveSession(context.workspace.id, signal)) {
      return {
        type: 'RETURN_ACTION',
        action: {
          type: 'WAITING',
          reason: 'Workspace has another working session',
        },
      };
    }

    return { type: 'TRIGGER_FIXER', retryCount: 0 };
  }

  /**
   * Persist the stall conclusion and publish it if this call is what flipped it.
   *
   * The write is pinned to the dispatch this check evaluated, so a concurrent PR
   * observation or disable wins. The event matters because a stall is, by
   * definition, nothing changing: the PR observation is identical to the cache
   * and the derived ratchet state is identical to the last one, so neither of
   * the two paths that normally refresh a snapshot fires. Without this emit the
   * WORKING-to-WAITING transition would wait for the next reconciliation sweep.
   */
  private async recordDispatchStalled(context: RatchetDecisionContext): Promise<void> {
    const marked = await this.workspace.markDispatchStalled(
      context.workspace.id,
      context.prStateInfo.snapshotKey
    );
    if (marked) {
      this.emit(RATCHET_DISPATCH_CHANGED, {
        workspaceId: context.workspace.id,
      } satisfies RatchetDispatchChangedEvent);
    }
  }

  private async decideDiedFixerRetry(
    context: RatchetDecisionContext,
    signal: AbortSignal = new AbortController().signal
  ): Promise<RatchetDecision> {
    if (context.dispatchRetryCount >= SERVICE_THRESHOLDS.ratchetDispatchMaxRetries) {
      await this.recordDispatchStalled(context);
      return {
        type: 'RETURN_ACTION',
        action: {
          type: 'WAITING',
          reason: `Fixer died ${context.dispatchRetryCount + 1} times for this PR state; waiting for PR state to change`,
        },
      };
    }
    signal.throwIfAborted();
    if (await this.hasActiveSession(context.workspace.id, signal)) {
      return {
        type: 'RETURN_ACTION',
        action: { type: 'WAITING', reason: 'Workspace has another working session' },
      };
    }
    return { type: 'TRIGGER_FIXER', retryCount: context.dispatchRetryCount + 1 };
  }

  private async applyRatchetDecision(
    context: RatchetDecisionContext,
    decision: RatchetDecision,
    signal: AbortSignal = new AbortController().signal,
    commitSideEffects: () => void = () => {
      // Direct private-method callers do not have a coordinator timeout to disable.
    }
  ): Promise<RatchetAction> {
    if (decision.type === 'RETURN_ACTION') {
      return decision.action;
    }

    signal.throwIfAborted();
    const action = await this.triggerFixer(
      context.workspace,
      context.prStateInfo,
      decision.retryCount,
      signal,
      commitSideEffects
    );
    signal.throwIfAborted();
    return action;
  }

  private hasActionableFixTrigger(prStateInfo: PRStateInfo): boolean {
    if (prStateInfo.ciStatus === CIStatus.FAILURE) {
      return true;
    }

    if (prStateInfo.hasMergeConflict) {
      return true;
    }

    if (prStateInfo.hasChangesRequested) {
      return true;
    }

    return (prStateInfo.reviewComments?.length ?? 0) > 0;
  }

  private async finishRatchetCheck(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    action: RatchetAction,
    decisionContext: RatchetDecisionContext,
    signal: AbortSignal = new AbortController().signal
  ): Promise<WorkspaceRatchetResult> {
    signal.throwIfAborted();
    const updateResult = await this.updateWorkspaceAfterCheck(
      workspace,
      prStateInfo,
      action,
      signal
    );
    signal.throwIfAborted();

    // The conditional update refused to persist: ratcheting was disabled while
    // this check was in flight. Report DISABLED and emit nothing — a disabled
    // workspace derives to IDLE, and the disable path emitted that transition.
    if (updateResult === 'disabled') {
      const disabledAction: RatchetAction = {
        type: 'DISABLED',
        reason: 'Workspace ratcheting disabled',
      };
      this.logWorkspaceRatchetingDecision(
        workspace,
        decisionContext.previousState,
        RatchetState.IDLE,
        disabledAction,
        prStateInfo,
        decisionContext
      );
      return {
        workspaceId: workspace.id,
        previousState: decisionContext.previousState,
        newState: RatchetState.IDLE,
        action: disabledAction,
      };
    }

    if (decisionContext.previousState !== decisionContext.newState) {
      this.emit(RATCHET_STATE_CHANGED, {
        workspaceId: workspace.id,
        fromState: decisionContext.previousState,
        toState: decisionContext.newState,
        prCiStatus: prStateInfo.ciStatus,
      } satisfies RatchetStateChangedEvent);
    }

    this.logWorkspaceRatchetingDecision(
      workspace,
      decisionContext.previousState,
      decisionContext.newState,
      action,
      prStateInfo,
      decisionContext
    );

    return {
      workspaceId: workspace.id,
      previousState: decisionContext.previousState,
      newState: decisionContext.newState,
      action,
    };
  }

  private hasStateChangedSinceLastDispatch(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo
  ): boolean {
    return workspace.ratchetDispatchSnapshotKey !== prStateInfo.snapshotKey;
  }

  /**
   * Persist what this check learned: the check timestamp, and the PR observation
   * the ratchet state is projected from.
   *
   * The state itself is not written — it is derived from the observation below, so
   * writing the observation *is* the transition. That also collapses the old
   * three-way result: with no stored state, no concurrent write can supersede this
   * one, leaving only "ratcheting was disabled while we ran".
   */
  private async updateWorkspaceAfterCheck(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    action: RatchetAction,
    signal: AbortSignal = new AbortController().signal
  ): Promise<'applied' | 'disabled'> {
    const now = new Date();
    // The dispatch record itself (session pointer, snapshot key, outcome,
    // retry count) is written atomically inside triggerFixer.
    const dispatched = action.type === 'TRIGGERED_FIXER' && action.promptSent;

    signal.throwIfAborted();
    const updated = await workspaceRatchetService.recordCheckIfEnabled(workspace.id, now);
    signal.throwIfAborted();

    if (!updated) {
      return 'disabled';
    }

    if (dispatched) {
      signal.throwIfAborted();
      await this.snapshot.recordReviewCheck(workspace.id, now);
      signal.throwIfAborted();
    }

    // Persist the whole observation, not just CI.
    //
    // `ratchetState` is projected from this cache, so anything the check saw and
    // kept to itself is something no later read can derive from. That used not to
    // matter: the check wrote its conclusion straight into a `state` column, so a
    // merge or a new changes-requested review reached the rest of the app even
    // though the cache had not caught up. Now the cache *is* the answer, and this
    // fetch is the only observer of the conflict flag at all.
    if (
      prStateInfo.ciStatus !== workspace.prCiStatus ||
      prStateInfo.cachedPrState !== workspace.prState ||
      prStateInfo.reviewDecision !== workspace.prReviewState ||
      prStateInfo.hasMergeConflict !== workspace.prHasMergeConflict
    ) {
      signal.throwIfAborted();
      await this.snapshot.recordPrObservation({
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
        prNumber: prStateInfo.prNumber,
        ciStatus: prStateInfo.ciStatus,
        prState: prStateInfo.cachedPrState,
        reviewState: prStateInfo.reviewDecision,
        hasMergeConflict: prStateInfo.hasMergeConflict,
        observedAt: now,
      });
      signal.throwIfAborted();
    }

    return 'applied';
  }

  private async checkActiveFixerSession(
    workspace: WorkspaceWithPR,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ActiveFixerCheckResult> {
    return await checkActiveFixerSessionHelper({
      workspace,
      sessionBridge: this.session,
      workspaceBridge: this.workspace,
      signal,
      onDispatchChanged: (event) => {
        this.emit(RATCHET_DISPATCH_CHANGED, event satisfies RatchetDispatchChangedEvent);
      },
    });
  }

  private async hasActiveSession(
    workspaceId: string,
    signal: AbortSignal = new AbortController().signal
  ): Promise<boolean> {
    return await hasActiveSessionHelper(workspaceId, this.session, signal);
  }

  private async fetchPRState(
    workspace: WorkspaceWithPR,
    authenticatedUsername: string | null,
    opts?: {
      bypassRecentFetchCooldown?: boolean;
      reviewTriggerMode?: RatchetReviewTriggerMode;
    },
    signal?: AbortSignal
  ): Promise<PRStateFetchResult> {
    return await fetchPRStateHelper({
      workspace,
      authenticatedUsername,
      reviewTriggerMode: opts?.reviewTriggerMode ?? 'CHANGES_REQUESTED',
      github: this.github,
      backoff: this.backoff,
      signal,
      bypassRecentFetchCooldown: opts?.bypassRecentFetchCooldown,
    });
  }

  private async getAuthenticatedUsernameCached(signal?: AbortSignal): Promise<string | null> {
    const { username, cache } = await getAuthenticatedUsernameCachedHelper({
      cachedValue: this.cachedAuthenticatedUsername,
      github: this.github,
      signal,
    });
    this.cachedAuthenticatedUsername = cache;
    return username;
  }

  private async triggerFixer(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    retryCount: number,
    signal: AbortSignal = new AbortController().signal,
    commitSideEffects: () => void = () => {
      // Direct private-method callers do not have a coordinator timeout to disable.
    }
  ): Promise<RatchetAction> {
    const action = await triggerRatchetFixer({
      workspace,
      prStateInfo,
      retryCount,
      sessionBridge: this.session,
      signal,
      commitSideEffects,
      onDispatchChanged: (event) => {
        this.emit(RATCHET_DISPATCH_CHANGED, event satisfies RatchetDispatchChangedEvent);
      },
    });
    return action;
  }

  private async stopActiveRatchetSessionsForMergedPr(
    workspaceId: string,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted();
    const sessions = await this.session.findSessionsByWorkspaceId(workspaceId);
    signal.throwIfAborted();
    const activeRatchetSessions = sessions.filter(
      (session) =>
        session.workflow === 'ratchet' &&
        (session.status === SessionStatus.RUNNING || session.status === SessionStatus.IDLE)
    );

    for (const session of activeRatchetSessions) {
      signal.throwIfAborted();
      if (!this.session.isSessionRunning(session.id)) {
        continue;
      }
      await this.session.stopSession(session.id);
      signal.throwIfAborted();
    }
  }

  private async stopActiveRatchetSessionsAfterDisable(workspaceId: string): Promise<void> {
    const sessions = await this.session.findSessionsByWorkspaceId(workspaceId);
    const activeRatchetSessions = sessions.filter(
      (session) =>
        session.workflow === 'ratchet' &&
        (session.status === SessionStatus.RUNNING || session.status === SessionStatus.IDLE)
    );

    for (const session of activeRatchetSessions) {
      if (!this.session.isSessionRunning(session.id)) {
        continue;
      }

      try {
        await this.session.stopSession(session.id);
      } catch (error) {
        logger.warn('Failed to stop ratchet session after disabling ratchet', {
          workspaceId,
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const ratchetService = new RatchetService();
