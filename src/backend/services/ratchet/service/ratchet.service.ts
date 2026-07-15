import { EventEmitter } from 'node:events';
import type { RatchetDispatchOutcome } from '@prisma-gen/client';
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

  async checkWorkspaceById(workspaceId: string): Promise<WorkspaceRatchetResult | null> {
    if (this.isShuttingDown) {
      return null;
    }

    const workspace = await workspaceAccessor.findForRatchetById(workspaceId);
    if (!workspace) {
      return null;
    }

    return this.runWorkspaceCheckSafely(workspace);
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
    workspace: WorkspaceWithPR
  ): Promise<WorkspaceRatchetResult> {
    try {
      return await this.checkCoordinator.run(workspace, () => this.processWorkspace(workspace));
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

    const activeSessionId = workspace.ratchetActiveSessionId;
    if (activeSessionId && this.session.isSessionRunning(activeSessionId)) {
      try {
        await this.session.stopSession(activeSessionId);
      } catch (error) {
        logger.warn('Failed to stop active ratchet session while disabling ratchet', {
          workspaceId,
          sessionId: activeSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await workspaceAccessor.update(workspaceId, {
      ratchetEnabled: false,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    });

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

  private async processWorkspace(workspace: WorkspaceWithPR): Promise<WorkspaceRatchetResult> {
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
      await workspaceAccessor.update(workspace.id, {
        ratchetState: newState,
        ratchetLastCheckedAt: new Date(),
      });
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
      const authenticatedUsername = await this.getAuthenticatedUsernameCached();
      const prStateResult = await this.fetchPRState(workspace, authenticatedUsername);
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
      const decisionContext = await this.buildRatchetDecisionContext(workspace, prStateInfo);
      const decision = this.decideRatchetAction(decisionContext);
      const action = await this.applyRatchetDecision(decisionContext, decision);

      return await this.finishRatchetCheck(workspace, prStateInfo, action, decisionContext);
    } catch (error) {
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
    prStateInfo: PRStateInfo
  ): Promise<RatchetDecisionContext> {
    const previousState = workspace.ratchetState;
    const newState = determineRatchetStateHelper(prStateInfo);
    const finalState = workspace.ratchetEnabled ? newState : RatchetState.IDLE;
    const hasNewReviewActivitySinceLastDispatch = hasNewReviewActivitySinceLastDispatchHelper(
      workspace,
      prStateInfo
    );
    const hasStateChangedSinceLastDispatch = this.hasStateChangedSinceLastDispatch(
      workspace,
      prStateInfo
    );
    const isCleanPrWithNoNewReviewActivity = shouldSkipCleanPRHelper(workspace, prStateInfo);

    const activeFixerCheck: ActiveFixerCheckResult =
      workspace.ratchetEnabled && prStateInfo.prState === 'OPEN'
        ? await this.checkActiveFixerSession(workspace)
        : { kind: 'none' };

    // The check above may have just settled a RUNNING record (e.g. to DIED);
    // use the settled outcome rather than the row read at the start of the check.
    const dispatchOutcome =
      activeFixerCheck.kind === 'settled'
        ? activeFixerCheck.outcome
        : workspace.ratchetDispatchOutcome;
    const dispatchRetryCount = workspace.ratchetDispatchRetryCount;

    const hasOtherActiveSession = await this.collectHasOtherActiveSession({
      workspace,
      activeFixerCheck,
      isCleanPrWithNoNewReviewActivity,
      hasStateChangedSinceLastDispatch,
      isRetryableDeath: this.isRetryableDeath(
        hasStateChangedSinceLastDispatch,
        dispatchOutcome,
        dispatchRetryCount
      ),
    });

    return {
      workspace,
      prStateInfo,
      previousState,
      newState,
      finalState,
      hasNewReviewActivitySinceLastDispatch,
      hasStateChangedSinceLastDispatch,
      isCleanPrWithNoNewReviewActivity,
      activeFixerCheck,
      dispatchOutcome,
      dispatchRetryCount,
      hasOtherActiveSession,
    };
  }

  private isRetryableDeath(
    hasStateChangedSinceLastDispatch: boolean,
    dispatchOutcome: RatchetDispatchOutcome | null,
    dispatchRetryCount: number
  ): boolean {
    return (
      !hasStateChangedSinceLastDispatch &&
      dispatchOutcome === 'DIED' &&
      dispatchRetryCount < SERVICE_THRESHOLDS.ratchetDispatchMaxRetries
    );
  }

  /**
   * Query for other working sessions only when the decision could actually
   * dispatch (mirrors the dispatch gates in decideRatchetAction to avoid a
   * DB query on the common no-op path).
   */
  private async collectHasOtherActiveSession(params: {
    workspace: WorkspaceWithPR;
    activeFixerCheck: ActiveFixerCheckResult;
    isCleanPrWithNoNewReviewActivity: boolean;
    hasStateChangedSinceLastDispatch: boolean;
    isRetryableDeath: boolean;
  }): Promise<boolean> {
    if (params.activeFixerCheck.kind === 'active') {
      return false;
    }
    if (params.activeFixerCheck.kind === 'ended_concurrently') {
      return false;
    }

    const couldDispatchFresh =
      params.hasStateChangedSinceLastDispatch && !params.isCleanPrWithNoNewReviewActivity;
    if (!(couldDispatchFresh || params.isRetryableDeath)) {
      return false;
    }

    return await this.hasActiveSession(params.workspace.id);
  }

  private decideRatchetAction(context: RatchetDecisionContext): RatchetDecision {
    if (!context.workspace.ratchetEnabled) {
      return {
        type: 'RETURN_ACTION',
        action: { type: 'DISABLED', reason: 'Workspace ratcheting disabled' },
      };
    }

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
      return this.decideDiedFixerRetry(context);
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

    if (context.hasOtherActiveSession) {
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

  private decideDiedFixerRetry(context: RatchetDecisionContext): RatchetDecision {
    if (context.dispatchRetryCount >= SERVICE_THRESHOLDS.ratchetDispatchMaxRetries) {
      return {
        type: 'RETURN_ACTION',
        action: {
          type: 'WAITING',
          reason: `Fixer died ${context.dispatchRetryCount + 1} times for this PR state; waiting for PR state to change`,
        },
      };
    }
    if (context.hasOtherActiveSession) {
      return {
        type: 'RETURN_ACTION',
        action: { type: 'WAITING', reason: 'Workspace has another working session' },
      };
    }
    return { type: 'TRIGGER_FIXER', retryCount: context.dispatchRetryCount + 1 };
  }

  private async applyRatchetDecision(
    context: RatchetDecisionContext,
    decision: RatchetDecision
  ): Promise<RatchetAction> {
    if (decision.type === 'RETURN_ACTION') {
      return decision.action;
    }

    return await this.triggerFixer(context.workspace, context.prStateInfo, decision.retryCount);
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
    decisionContext: RatchetDecisionContext
  ): Promise<WorkspaceRatchetResult> {
    const updateApplied = await this.updateWorkspaceAfterCheck(
      workspace,
      prStateInfo,
      action,
      decisionContext.finalState
    );
    const resultAction: RatchetAction = updateApplied
      ? action
      : { type: 'DISABLED', reason: 'Workspace ratcheting disabled' };
    const resultState = updateApplied ? decisionContext.finalState : RatchetState.IDLE;
    if (updateApplied && decisionContext.previousState !== decisionContext.finalState) {
      this.emit(RATCHET_STATE_CHANGED, {
        workspaceId: workspace.id,
        fromState: decisionContext.previousState,
        toState: decisionContext.finalState,
        prCiStatus: prStateInfo.ciStatus,
      } satisfies RatchetStateChangedEvent);
    }

    this.logWorkspaceRatchetingDecision(
      workspace,
      decisionContext.previousState,
      resultState,
      resultAction,
      prStateInfo,
      decisionContext
    );

    return {
      workspaceId: workspace.id,
      previousState: decisionContext.previousState,
      newState: resultState,
      action: resultAction,
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
    nextState: RatchetState
  ): Promise<boolean> {
    const now = new Date();
    // The dispatch record itself (session pointer, snapshot key, outcome,
    // retry count) is written atomically inside triggerFixer.
    const dispatched = action.type === 'TRIGGERED_FIXER' && action.promptSent;

    const updated = await workspaceAccessor.updateRatchetCheckIfEnabled(workspace.id, {
      ratchetState: nextState,
      ratchetLastCheckedAt: now,
    });

    if (!updated) {
      return false;
    }

    if (dispatched) {
      await this.snapshot.recordReviewCheck(workspace.id, now);
    }

    if (prStateInfo.ciStatus !== workspace.prCiStatus) {
      await this.snapshot.recordCIObservation({
        workspaceId: workspace.id,
        ciStatus: prStateInfo.ciStatus,
        observedAt: now,
      });
    }

    return true;
  }

  private async checkActiveFixerSession(
    workspace: WorkspaceWithPR
  ): Promise<ActiveFixerCheckResult> {
    return await checkActiveFixerSessionHelper({
      workspace,
      sessionBridge: this.session,
    });
  }

  private async hasActiveSession(workspaceId: string): Promise<boolean> {
    return await hasActiveSessionHelper(workspaceId, this.session);
  }

  private async fetchPRState(
    workspace: WorkspaceWithPR,
    authenticatedUsername: string | null,
    opts?: { bypassRecentFetchCooldown?: boolean }
  ): Promise<PRStateFetchResult> {
    return await fetchPRStateHelper({
      workspace,
      authenticatedUsername,
      github: this.github,
      backoff: this.backoff,
      bypassRecentFetchCooldown: opts?.bypassRecentFetchCooldown,
    });
  }

  private async getAuthenticatedUsernameCached(): Promise<string | null> {
    const { username, cache } = await getAuthenticatedUsernameCachedHelper({
      cachedValue: this.cachedAuthenticatedUsername,
      github: this.github,
    });
    this.cachedAuthenticatedUsername = cache;
    return username;
  }

  private async triggerFixer(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    retryCount: number
  ): Promise<RatchetAction> {
    return await triggerRatchetFixer({
      workspace,
      prStateInfo,
      sessionBridge: this.session,
      recordDispatch: (workspaceId, sessionId) =>
        workspaceAccessor.recordRatchetDispatchIfEnabled(workspaceId, {
          sessionId,
          snapshotKey: prStateInfo.snapshotKey,
          retryCount,
        }),
      adoptActiveSession: (workspaceId, sessionId) =>
        workspaceAccessor.adoptRatchetActiveSessionIfEnabled(workspaceId, sessionId),
      clearActiveSession: (workspaceId) => this.clearActiveSession(workspaceId),
      logger,
    });
  }

  private async clearActiveSession(workspaceId: string): Promise<void> {
    await workspaceAccessor.update(workspaceId, { ratchetActiveSessionId: null });
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
