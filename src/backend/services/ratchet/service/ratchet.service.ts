import { EventEmitter } from 'node:events';
import type { RatchetDispatchOutcome } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { toError } from '@/backend/lib/error-utils';
import {
  SERVICE_INTERVAL_MS,
  SERVICE_THRESHOLDS,
  SERVICE_TIMEOUT_MS,
} from '@/backend/services/constants';
import { createLogger } from '@/backend/services/logger.service';
import { RateLimitBackoff } from '@/backend/services/rate-limit-backoff';
import { workspaceAccessor } from '@/backend/services/workspace';
import { CIStatus, RatchetState, SessionStatus } from '@/shared/core';
import type { RatchetGitHubBridge, RatchetPRSnapshotBridge, RatchetSessionBridge } from './bridges';
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
import { RatchetWorkspaceCheckCoordinator } from './ratchet-workspace-check-coordinator';

const logger = createLogger('ratchet');
const RATCHET_WORKSPACE_CONCURRENCY = 3;
const ratchetWorkspaceLimit = pLimit(RATCHET_WORKSPACE_CONCURRENCY);

const RECENTLY_FETCHED_REASON: PRStateFetchSkipped['reason'] = 'recently_fetched';

function isRecentlyFetchedWaitResult(result: WorkspaceRatchetResult): boolean {
  return result.action.type === 'WAITING' && result.action.reason === RECENTLY_FETCHED_REASON;
}

export type { RatchetAction, RatchetCheckResult, WorkspaceRatchetResult } from './ratchet.types';

export const RATCHET_STATE_CHANGED = 'ratchet_state_changed' as const;
export const RATCHET_TOGGLED = 'ratchet_toggled' as const;

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

class RatchetService extends EventEmitter {
  private isShuttingDown = false;
  private monitorLoop: Promise<void> | null = null;
  private sleepTimeout: NodeJS.Timeout | null = null;
  private sleepResolve: (() => void) | null = null;
  private workspaceCheckTimeoutMs = SERVICE_TIMEOUT_MS.ratchetWorkspaceCheck;
  private readonly checkCoordinator = new RatchetWorkspaceCheckCoordinator(
    () => this.workspaceCheckTimeoutMs
  );
  private cachedAuthenticatedUsername: AuthenticatedUsernameCache | null = null;
  private readonly backoff = new RateLimitBackoff();

  private sessionBridge: RatchetSessionBridge | null = null;
  private githubBridge: RatchetGitHubBridge | null = null;
  private snapshotBridge: RatchetPRSnapshotBridge | null = null;

  configure(bridges: {
    session: RatchetSessionBridge;
    github: RatchetGitHubBridge;
    snapshot: RatchetPRSnapshotBridge;
  }): void {
    this.sessionBridge = bridges.session;
    this.githubBridge = bridges.github;
    this.snapshotBridge = bridges.snapshot;
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
    if (this.monitorLoop !== null) {
      return;
    }

    this.isShuttingDown = false;
    this.monitorLoop = this.runContinuousLoop();

    logger.info('Ratchet service started', { intervalMs: SERVICE_INTERVAL_MS.ratchetPoll });
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    this.wakeSleep();

    if (this.monitorLoop !== null) {
      logger.debug('Waiting for ratchet monitor loop to complete');
      await this.monitorLoop;
      this.monitorLoop = null;
    }

    logger.info('Ratchet service stopped');
  }

  private async runContinuousLoop(): Promise<void> {
    while (!this.isShuttingDown) {
      try {
        this.backoff.beginCycle();
        await this.checkAllWorkspaces();
        this.backoff.resetIfCleanCycle(logger, 'Ratchet');
      } catch (err) {
        logger.error('Ratchet check failed', toError(err));
      }

      if (!this.isShuttingDown) {
        const delayMs = this.backoff.computeDelay(SERVICE_INTERVAL_MS.ratchetPoll);
        if (this.backoff.currentMultiplier > 1) {
          logger.debug('Using backoff delay for next ratchet check', {
            baseIntervalMs: SERVICE_INTERVAL_MS.ratchetPoll,
            backoffMultiplier: this.backoff.currentMultiplier,
            delayMs,
          });
        }
        await this.sleep(delayMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.sleepTimeout) {
          clearTimeout(this.sleepTimeout);
          this.sleepTimeout = null;
        }
        if (this.sleepResolve === finish) {
          this.sleepResolve = null;
        }
        resolve();
      };

      this.sleepResolve = finish;
      this.sleepTimeout = setTimeout(finish, ms);

      if (this.isShuttingDown) {
        finish();
      }
    });
  }

  private wakeSleep(): void {
    const resolveSleep = this.sleepResolve;
    if (resolveSleep) {
      resolveSleep();
    }
  }

  async checkAllWorkspaces(): Promise<RatchetCheckResult> {
    if (this.isShuttingDown) {
      return { checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] };
    }

    const workspaces = await workspaceAccessor.findWithPRsForRatchet();

    if (workspaces.length === 0) {
      return { checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] };
    }

    const results = await Promise.all(
      workspaces.map((workspace) => this.runWorkspaceCheckSafely(workspace))
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

    const workspace = await workspaceAccessor.findForRatchetById(workspaceId);
    if (!workspace) {
      return null;
    }

    const result = await this.runWorkspaceCheckSafely(workspace, opts);

    // A bypassed check can still come back dedup-skipped: the coordinator may
    // have joined a normal check that was already in flight, or another
    // service's fetch was actively in flight. Rerun once now that the
    // concurrent work has settled so the bypass actually applies.
    if (opts?.bypassPrFetchCooldown && isRecentlyFetchedWaitResult(result)) {
      const freshWorkspace = await workspaceAccessor.findForRatchetById(workspaceId);
      if (!freshWorkspace) {
        return result;
      }
      return this.runWorkspaceCheckSafely(freshWorkspace, opts);
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
    await workspaceAccessor.recordRatchetSessionEnd(workspaceId, sessionId, outcome);
  }

  /**
   * Settle ratchet state for a workspace whose PR is closed (not merged).
   * Closed PRs are excluded from the poll set, so the poll loop can no longer
   * transition them to IDLE itself. Idempotent; no GitHub fetch.
   */
  async markPrClosed(workspaceId: string): Promise<void> {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace || workspace.ratchetState === RatchetState.IDLE) {
      return;
    }

    const updated = await workspaceAccessor.updateRatchetCheckIfEnabled(workspaceId, {
      ratchetState: RatchetState.IDLE,
      ratchetLastCheckedAt: new Date(),
    });
    if (!updated) {
      return;
    }

    this.emit(RATCHET_STATE_CHANGED, {
      workspaceId,
      fromState: workspace.ratchetState,
      toState: RatchetState.IDLE,
    } satisfies RatchetStateChangedEvent);
  }

  private async runWorkspaceCheckSafely(
    workspace: WorkspaceWithPR,
    opts?: RatchetCheckOptions
  ): Promise<WorkspaceRatchetResult> {
    try {
      return await this.checkCoordinator.run(workspace, (signal) =>
        ratchetWorkspaceLimit(() => {
          signal.throwIfAborted();
          return this.processWorkspace(workspace, opts, signal);
        })
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
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    if (enabled) {
      await workspaceAccessor.update(workspaceId, {
        ratchetEnabled: true,
      });
      this.emit(RATCHET_TOGGLED, {
        workspaceId,
        enabled: true,
        ratchetState: workspace.ratchetState,
      } satisfies RatchetToggledEvent);
      return;
    }

    await workspaceAccessor.update(workspaceId, {
      ratchetEnabled: false,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    });

    // Stops every running ratchet-workflow session, including the one the
    // (now cleared) active-session pointer named.
    await this.stopActiveRatchetSessionsAfterDisable(workspaceId);

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
    signal: AbortSignal = new AbortController().signal
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
      const newState = RatchetState.IDLE;
      signal.throwIfAborted();
      await workspaceAccessor.update(workspace.id, {
        ratchetState: newState,
        ratchetLastCheckedAt: new Date(),
      });
      signal.throwIfAborted();
      if (workspace.ratchetState !== newState) {
        this.emit(RATCHET_STATE_CHANGED, {
          workspaceId: workspace.id,
          fromState: workspace.ratchetState,
          toState: newState,
        } satisfies RatchetStateChangedEvent);
      }
      this.logWorkspaceRatchetingDecision(
        workspace,
        workspace.ratchetState,
        newState,
        action,
        null
      );
      return {
        workspaceId: workspace.id,
        previousState: workspace.ratchetState,
        newState,
        action,
      };
    }

    try {
      signal.throwIfAborted();
      const authenticatedUsername = await this.getAuthenticatedUsernameCached(signal);
      signal.throwIfAborted();
      const prStateResult = await this.fetchPRState(
        workspace,
        authenticatedUsername,
        {
          bypassRecentFetchCooldown: opts?.bypassPrFetchCooldown,
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
      const decisionContext = await this.buildRatchetDecisionContext(
        workspace,
        prStateInfo,
        signal
      );
      signal.throwIfAborted();
      const decision = await this.decideRatchetAction(decisionContext, signal);
      signal.throwIfAborted();
      const action = await this.applyRatchetDecision(decisionContext, decision, signal);
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

  private async decideDiedFixerRetry(
    context: RatchetDecisionContext,
    signal: AbortSignal = new AbortController().signal
  ): Promise<RatchetDecision> {
    if (context.dispatchRetryCount >= SERVICE_THRESHOLDS.ratchetDispatchMaxRetries) {
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
    signal: AbortSignal = new AbortController().signal
  ): Promise<RatchetAction> {
    if (decision.type === 'RETURN_ACTION') {
      return decision.action;
    }

    signal.throwIfAborted();
    const action = await this.triggerFixer(
      context.workspace,
      context.prStateInfo,
      decision.retryCount,
      signal
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
    const updateApplied = await this.updateWorkspaceAfterCheck(
      workspace,
      prStateInfo,
      action,
      decisionContext.newState,
      signal
    );
    signal.throwIfAborted();

    // The conditional update refused to persist: ratcheting was disabled while
    // this check was in flight. Report DISABLED and emit nothing — the disable
    // path already settled the workspace to IDLE.
    if (!updateApplied) {
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
    return workspace.ratchetLastCiRunId !== prStateInfo.snapshotKey;
  }

  private async updateWorkspaceAfterCheck(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    action: RatchetAction,
    nextState: RatchetState,
    signal: AbortSignal = new AbortController().signal
  ): Promise<boolean> {
    const now = new Date();
    // The dispatch record itself (session pointer, snapshot key, outcome,
    // retry count) is written atomically inside triggerFixer.
    const dispatched = action.type === 'TRIGGERED_FIXER' && action.promptSent;

    signal.throwIfAborted();
    const updated = await workspaceAccessor.updateRatchetCheckIfEnabled(workspace.id, {
      ratchetState: nextState,
      ratchetLastCheckedAt: now,
    });
    signal.throwIfAborted();

    if (!updated) {
      return false;
    }

    if (dispatched) {
      signal.throwIfAborted();
      await this.snapshot.recordReviewCheck(workspace.id, now);
      signal.throwIfAborted();
    }

    if (prStateInfo.ciStatus !== workspace.prCiStatus) {
      signal.throwIfAborted();
      await this.snapshot.recordCIObservation({
        workspaceId: workspace.id,
        ciStatus: prStateInfo.ciStatus,
        observedAt: now,
      });
      signal.throwIfAborted();
    }

    return true;
  }

  private async checkActiveFixerSession(
    workspace: WorkspaceWithPR,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ActiveFixerCheckResult> {
    return await checkActiveFixerSessionHelper({
      workspace,
      sessionBridge: this.session,
      signal,
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
    opts?: { bypassRecentFetchCooldown?: boolean },
    signal?: AbortSignal
  ): Promise<PRStateFetchResult> {
    return await fetchPRStateHelper({
      workspace,
      authenticatedUsername,
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
    signal: AbortSignal = new AbortController().signal
  ): Promise<RatchetAction> {
    return await triggerRatchetFixer({
      workspace,
      prStateInfo,
      retryCount,
      sessionBridge: this.session,
      signal,
    });
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
