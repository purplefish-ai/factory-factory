/**
 * Ratchet Service
 *
 * Simplified ratchet loop:
 * - Poll workspaces with PRs
 * - Dispatch ratchet only when PR state changed since last dispatch
 * - Dispatch only when workspace is idle (no active ratchet or other chat session)
 */

import { EventEmitter } from 'node:events';
import pLimit from 'p-limit';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import {
  SERVICE_CONCURRENCY,
  SERVICE_INTERVAL_MS,
  SERVICE_TIMEOUT_MS,
} from '@/backend/services/constants';
import { createLogger } from '@/backend/services/logger.service';
import { RateLimitBackoff } from '@/backend/services/rate-limit-backoff';
import { CIStatus, RatchetState } from '@/shared/core';
import type { RatchetGitHubBridge, RatchetPRSnapshotBridge, RatchetSessionBridge } from './bridges';
import type {
  PRStateInfo,
  RatchetAction,
  RatchetCheckResult,
  RatchetDecision,
  RatchetDecisionContext,
  ReviewPollResult,
  ReviewPollTracker,
  WorkspaceRatchetResult,
  WorkspaceWithPR,
} from './ratchet.types';
import {
  getActiveRatchetSession as getActiveRatchetSessionHelper,
  hasActiveSession as hasActiveSessionHelper,
} from './ratchet-active-session.helpers';
import { triggerRatchetFixer } from './ratchet-fixer-dispatch.helpers';
import type { AuthenticatedUsernameCache } from './ratchet-pr-state.helpers';
import {
  buildFailedCheckDiagnostics as buildFailedCheckDiagnosticsHelper,
  buildReviewTimestampDiagnostics as buildReviewTimestampDiagnosticsHelper,
  buildSnapshotDiagnostics as buildSnapshotDiagnosticsHelper,
  computeDispatchSnapshotKey as computeDispatchSnapshotKeyHelper,
  computeLatestReviewActivityAtMs as computeLatestReviewActivityAtMsHelper,
  determineRatchetState as determineRatchetStateHelper,
  fetchPRState as fetchPRStateHelper,
  getAuthenticatedUsernameCached as getAuthenticatedUsernameCachedHelper,
  hasNewReviewActivitySinceLastDispatch as hasNewReviewActivitySinceLastDispatchHelper,
  shouldSkipCleanPR as shouldSkipCleanPRHelper,
} from './ratchet-pr-state.helpers';
import { handleReviewCommentPoll as handleReviewCommentPollHelper } from './ratchet-review-poll.helpers';

const logger = createLogger('ratchet');

export type { RatchetAction, RatchetCheckResult, WorkspaceRatchetResult } from './ratchet.types';

export const RATCHET_STATE_CHANGED = 'ratchet_state_changed' as const;
export const RATCHET_TOGGLED = 'ratchet_toggled' as const;

export interface RatchetStateChangedEvent {
  workspaceId: string;
  fromState: RatchetState;
  toState: RatchetState;
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
  private readonly checkLimit = pLimit(SERVICE_CONCURRENCY.ratchetWorkspaceChecks);
  private readonly inFlightWorkspaceChecks = new Map<string, Promise<WorkspaceRatchetResult>>();
  private cachedAuthenticatedUsername: AuthenticatedUsernameCache | null = null;
  private readonly backoff = new RateLimitBackoff();
  private readonly reviewPollTrackers = new Map<string, ReviewPollTracker>();

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
        logger.error('Ratchet check failed', err as Error);
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
      workspaces.map((workspace) => this.checkLimit(() => this.runWorkspaceCheckSafely(workspace)))
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

  private async runWorkspaceCheckSafely(
    workspace: WorkspaceWithPR
  ): Promise<WorkspaceRatchetResult> {
    const checkPromise = this.runWorkspaceCheck(workspace.id, () =>
      this.processWorkspace(workspace)
    );

    try {
      return await this.withWorkspaceCheckTimeout(workspace, checkPromise);
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

  private withWorkspaceCheckTimeout(
    workspace: WorkspaceWithPR,
    checkPromise: Promise<WorkspaceRatchetResult>
  ): Promise<WorkspaceRatchetResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.inFlightWorkspaceChecks.get(workspace.id) === checkPromise) {
          this.inFlightWorkspaceChecks.delete(workspace.id);
        }
        reject(new Error(`Workspace check timed out after ${this.workspaceCheckTimeoutMs}ms`));
      }, this.workspaceCheckTimeoutMs);
      timeout.unref?.();

      checkPromise.then(resolve, reject).finally(() => {
        clearTimeout(timeout);
      });
    });
  }

  private runWorkspaceCheck(
    workspaceId: string,
    runner: () => Promise<WorkspaceRatchetResult>
  ): Promise<WorkspaceRatchetResult> {
    const existing = this.inFlightWorkspaceChecks.get(workspaceId);
    if (existing) {
      return existing;
    }

    const inFlight = runner().finally(() => {
      if (this.inFlightWorkspaceChecks.get(workspaceId) === inFlight) {
        this.inFlightWorkspaceChecks.delete(workspaceId);
      }
    });
    this.inFlightWorkspaceChecks.set(workspaceId, inFlight);
    return inFlight;
  }

  /**
   * Enable or disable ratcheting for a workspace.
   * Ratchet domain owns ratchet state fields, so toggles flow through this service.
   */
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
    });

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

    // Skip GitHub API calls for disabled workspaces — just settle to IDLE
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
      const prStateInfo = await this.fetchPRState(workspace, authenticatedUsername);
      if (!prStateInfo) {
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

      const decisionContext = await this.buildRatchetDecisionContext(workspace, prStateInfo);
      const decision = this.decideRatchetAction(decisionContext);

      if (prStateInfo.prState === 'MERGED') {
        this.reviewPollTrackers.delete(workspace.id);
      } else if (decisionContext.isCleanPrWithNoNewReviewActivity) {
        const pollDispatch = await this.processReviewCommentPoll(
          workspace,
          prStateInfo,
          authenticatedUsername
        );
        if (pollDispatch) {
          return pollDispatch;
        }
      } else {
        this.reviewPollTrackers.delete(workspace.id);
      }

      const action = await this.applyRatchetDecision(decisionContext, decision);

      await this.updateWorkspaceAfterCheck(
        workspace,
        prStateInfo,
        action,
        decisionContext.finalState
      );
      if (decisionContext.previousState !== decisionContext.finalState) {
        this.emit(RATCHET_STATE_CHANGED, {
          workspaceId: workspace.id,
          fromState: decisionContext.previousState,
          toState: decisionContext.finalState,
        } satisfies RatchetStateChangedEvent);
      }
      this.logWorkspaceRatchetingDecision(
        workspace,
        decisionContext.previousState,
        decisionContext.finalState,
        action,
        prStateInfo,
        decisionContext
      );

      return {
        workspaceId: workspace.id,
        previousState: decisionContext.previousState,
        newState: decisionContext.finalState,
        action,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error processing workspace in ratchet', error as Error, {
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
    const prNumber = prStateInfo?.prNumber ?? workspace.prNumber;
    const prNumberLabel = prNumber ?? 'unknown';
    const workspacePrPrefix = `workspace ${workspace.id} for PR #${prNumberLabel}`;
    const context = this.buildRatchetingLogContext(
      workspace,
      previousState,
      newState,
      action,
      prStateInfo,
      prNumber,
      decisionContext
    );

    if (action.type === 'TRIGGERED_FIXER') {
      logger.info(`Ratcheting ${workspacePrPrefix}`, {
        ...context,
        sessionId: action.sessionId,
        promptSent: action.promptSent,
      });
      return;
    }

    const reason = this.describeNonRatchetingReason(action);

    logger.info(`Not ratcheting ${workspacePrPrefix} because ${reason}`, context);
  }

  private buildRatchetingLogContext(
    workspace: WorkspaceWithPR,
    previousState: RatchetState,
    newState: RatchetState,
    action: RatchetAction,
    prStateInfo: PRStateInfo | null,
    prNumber: number | null,
    decisionContext: RatchetDecisionContext | null
  ) {
    const reviewDiagnostics = this.buildReviewTimestampDiagnostics(
      workspace,
      prStateInfo,
      decisionContext
    );
    const snapshotDiagnostics = this.buildSnapshotDiagnostics(
      workspace,
      prStateInfo,
      decisionContext
    );
    const latestReviewActivityAt = reviewDiagnostics.latestReviewActivityAtMs;

    return {
      workspaceId: workspace.id,
      prUrl: workspace.prUrl,
      prNumber,
      prState: prStateInfo?.prState ?? null,
      ciStatus: prStateInfo?.ciStatus ?? null,
      hasChangesRequested: prStateInfo?.hasChangesRequested ?? null,
      snapshotKey: prStateInfo?.snapshotKey ?? null,
      ciSnapshotKey: snapshotDiagnostics.ciSnapshotKey,
      snapshotComparison: snapshotDiagnostics.snapshotComparison,
      previousState,
      newState,
      ratchetEnabled: workspace.ratchetEnabled,
      ratchetActiveSessionId: workspace.ratchetActiveSessionId,
      ratchetLastCiRunId: workspace.ratchetLastCiRunId,
      ciStatusCheckRollup: prStateInfo?.statusCheckRollup ?? null,
      ciFailedChecks: this.buildFailedCheckDiagnostics(prStateInfo),
      prReviewLastCheckedAt: workspace.prReviewLastCheckedAt?.toISOString() ?? null,
      latestReviewActivityAt: latestReviewActivityAt
        ? new Date(latestReviewActivityAt).toISOString()
        : null,
      reviewTimestampComparison: reviewDiagnostics.reviewTimestampComparison,
      actionType: action.type,
    };
  }

  private buildSnapshotDiagnostics(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo | null,
    decisionContext: RatchetDecisionContext | null
  ) {
    return buildSnapshotDiagnosticsHelper(workspace, prStateInfo, decisionContext);
  }

  private buildReviewTimestampDiagnostics(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo | null,
    decisionContext: RatchetDecisionContext | null
  ) {
    return buildReviewTimestampDiagnosticsHelper(workspace, prStateInfo, decisionContext, logger);
  }

  private buildFailedCheckDiagnostics(prStateInfo: PRStateInfo | null) {
    return buildFailedCheckDiagnosticsHelper(prStateInfo);
  }

  private describeNonRatchetingReason(
    action: Exclude<RatchetAction, { type: 'TRIGGERED_FIXER' }>
  ): string {
    switch (action.type) {
      case 'WAITING':
        return action.reason;
      case 'FIXER_ACTIVE':
        return `Ratchet fixer session is already active (${action.sessionId})`;
      case 'DISABLED':
        return action.reason;
      case 'COMPLETED':
        return 'PR is already merged';
      case 'ERROR':
        return action.error;
    }
    const exhaustiveCheck: never = action;
    throw new Error(`Unhandled ratchet action: ${JSON.stringify(exhaustiveCheck)}`);
  }

  private async buildRatchetDecisionContext(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo
  ): Promise<RatchetDecisionContext> {
    const previousState = workspace.ratchetState;
    const newState = this.determineRatchetState(prStateInfo);
    const finalState = workspace.ratchetEnabled ? newState : RatchetState.IDLE;
    const hasNewReviewActivitySinceLastDispatch = this.hasNewReviewActivitySinceLastDispatch(
      workspace,
      prStateInfo
    );
    const hasStateChangedSinceLastDispatch = this.hasStateChangedSinceLastDispatch(
      workspace,
      prStateInfo
    );
    const isCleanPrWithNoNewReviewActivity = this.shouldSkipCleanPR(workspace, prStateInfo);

    const activityChecks = await this.collectRatchetingActivityChecks(
      workspace,
      prStateInfo,
      isCleanPrWithNoNewReviewActivity,
      hasStateChangedSinceLastDispatch
    );

    return {
      workspace,
      prStateInfo,
      previousState,
      newState,
      finalState,
      hasNewReviewActivitySinceLastDispatch,
      hasStateChangedSinceLastDispatch,
      isCleanPrWithNoNewReviewActivity,
      activeRatchetSession: activityChecks.activeRatchetSession,
      hasOtherActiveSession: activityChecks.hasOtherActiveSession,
    };
  }

  private async collectRatchetingActivityChecks(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    isCleanPrWithNoNewReviewActivity: boolean,
    hasStateChangedSinceLastDispatch: boolean
  ): Promise<{
    activeRatchetSession: RatchetAction | null;
    hasOtherActiveSession: boolean;
  }> {
    if (
      !workspace.ratchetEnabled ||
      prStateInfo.prState !== 'OPEN' ||
      isCleanPrWithNoNewReviewActivity
    ) {
      return {
        activeRatchetSession: null,
        hasOtherActiveSession: false,
      };
    }

    const activeRatchetSession = await this.getActiveRatchetSession(workspace);
    if (activeRatchetSession) {
      return {
        activeRatchetSession,
        hasOtherActiveSession: false,
      };
    }

    if (!hasStateChangedSinceLastDispatch) {
      return {
        activeRatchetSession: null,
        hasOtherActiveSession: false,
      };
    }

    return {
      activeRatchetSession: null,
      hasOtherActiveSession: await this.hasActiveSession(workspace.id),
    };
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

    // Only dispatch when CI is in a terminal state (SUCCESS or FAILURE)
    const isTerminalCIStatus =
      context.prStateInfo.ciStatus === CIStatus.SUCCESS ||
      context.prStateInfo.ciStatus === CIStatus.FAILURE;

    if (!isTerminalCIStatus) {
      return {
        type: 'RETURN_ACTION',
        action: { type: 'WAITING', reason: 'Waiting for CI to complete (not in terminal state)' },
      };
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

    if (context.activeRatchetSession) {
      return { type: 'RETURN_ACTION', action: context.activeRatchetSession };
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
          reason: 'Workspace is not idle (active session)',
        },
      };
    }

    return { type: 'TRIGGER_FIXER' };
  }

  private async applyRatchetDecision(
    context: RatchetDecisionContext,
    decision: RatchetDecision
  ): Promise<RatchetAction> {
    if (decision.type === 'RETURN_ACTION') {
      return decision.action;
    }

    return await this.triggerFixer(context.workspace, context.prStateInfo);
  }

  private hasActionableFixTrigger(prStateInfo: PRStateInfo): boolean {
    if (prStateInfo.ciStatus === CIStatus.FAILURE) {
      return true;
    }

    return (prStateInfo.reviewComments?.length ?? 0) > 0;
  }

  private shouldSkipCleanPR(workspace: WorkspaceWithPR, prStateInfo: PRStateInfo): boolean {
    return shouldSkipCleanPRHelper(workspace, prStateInfo, logger);
  }

  private hasNewReviewActivitySinceLastDispatch(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo
  ): boolean {
    return hasNewReviewActivitySinceLastDispatchHelper(workspace, prStateInfo, logger);
  }

  private async processReviewCommentPoll(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    authenticatedUsername: string | null
  ): Promise<WorkspaceRatchetResult | null> {
    const pollResult = await this.handleReviewCommentPoll(
      workspace,
      prStateInfo,
      authenticatedUsername
    );

    if (pollResult.action !== 'comments-found') {
      return null;
    }

    const freshContext = await this.buildRatchetDecisionContext(workspace, pollResult.freshPrState);
    const freshDecision = this.decideRatchetAction(freshContext);
    const freshAction = await this.applyRatchetDecision(freshContext, freshDecision);

    await this.updateWorkspaceAfterCheck(
      workspace,
      pollResult.freshPrState,
      freshAction,
      freshContext.finalState
    );
    if (freshContext.previousState !== freshContext.finalState) {
      this.emit(RATCHET_STATE_CHANGED, {
        workspaceId: workspace.id,
        fromState: freshContext.previousState,
        toState: freshContext.finalState,
      } satisfies RatchetStateChangedEvent);
    }

    this.logWorkspaceRatchetingDecision(
      workspace,
      freshContext.previousState,
      freshContext.finalState,
      freshAction,
      pollResult.freshPrState,
      freshContext
    );

    return {
      workspaceId: workspace.id,
      previousState: freshContext.previousState,
      newState: freshContext.finalState,
      action: freshAction,
    };
  }

  private async handleReviewCommentPoll(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    authenticatedUsername: string | null
  ): Promise<ReviewPollResult> {
    return await handleReviewCommentPollHelper({
      workspace,
      prStateInfo,
      authenticatedUsername,
      reviewPollTrackers: this.reviewPollTrackers,
      isShuttingDown: this.isShuttingDown,
      fetchPRState: (workspaceArg, authenticatedUsernameArg) =>
        this.fetchPRState(workspaceArg, authenticatedUsernameArg),
      shouldSkipCleanPR: (workspaceArg, prStateInfoArg) =>
        this.shouldSkipCleanPR(workspaceArg, prStateInfoArg),
      logger,
    });
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
  ): Promise<void> {
    const now = new Date();
    const dispatched = action.type === 'TRIGGERED_FIXER' && action.promptSent;

    await workspaceAccessor.update(workspace.id, {
      ratchetState: nextState,
      ratchetLastCheckedAt: now,
      ...(dispatched
        ? {
            ratchetLastCiRunId: prStateInfo.snapshotKey,
          }
        : {}),
    });

    if (dispatched) {
      await this.snapshot.recordReviewCheck(workspace.id, now);
    }
  }

  private async getActiveRatchetSession(workspace: WorkspaceWithPR): Promise<RatchetAction | null> {
    return await getActiveRatchetSessionHelper({
      workspace,
      sessionBridge: this.session,
      snapshotBridge: this.snapshot,
      resetDispatchState: (workspaceId) => this.resetDispatchState(workspaceId),
      clearActiveSession: (workspaceId) => this.clearActiveSession(workspaceId),
      logger,
    });
  }

  private async hasActiveSession(workspaceId: string): Promise<boolean> {
    return await hasActiveSessionHelper(workspaceId, this.session);
  }

  private async fetchPRState(
    workspace: WorkspaceWithPR,
    authenticatedUsername: string | null
  ): Promise<PRStateInfo | null> {
    return await fetchPRStateHelper({
      workspace,
      authenticatedUsername,
      github: this.github,
      backoff: this.backoff,
      logger,
      computeLatestReviewActivityAtMs: (prDetails, reviewComments, authenticatedUsernameArg) =>
        this.computeLatestReviewActivityAtMs(prDetails, reviewComments, authenticatedUsernameArg),
      computeDispatchSnapshotKey: (
        ciStatus,
        hasChangesRequested,
        latestReviewActivityAtMs,
        statusChecks
      ) =>
        this.computeDispatchSnapshotKey(
          ciStatus,
          hasChangesRequested,
          latestReviewActivityAtMs,
          statusChecks
        ),
    });
  }

  private computeDispatchSnapshotKey(
    ciStatus: CIStatus,
    hasChangesRequested: boolean,
    latestReviewActivityAtMs: number | null,
    statusChecks: PRStateInfo['statusCheckRollup']
  ): string {
    return computeDispatchSnapshotKeyHelper(
      ciStatus,
      hasChangesRequested,
      latestReviewActivityAtMs,
      statusChecks
    );
  }

  private computeLatestReviewActivityAtMs(
    prDetails: {
      reviews: Array<{ submittedAt: string | null; author: { login: string } }>;
      comments: Array<{ updatedAt: string; author: { login: string } }>;
    },
    reviewComments: Array<{ updatedAt: string; author: { login: string } }>,
    authenticatedUsername: string | null
  ): number | null {
    return computeLatestReviewActivityAtMsHelper(prDetails, reviewComments, authenticatedUsername);
  }

  private async getAuthenticatedUsernameCached(): Promise<string | null> {
    const { username, cache } = await getAuthenticatedUsernameCachedHelper({
      cachedValue: this.cachedAuthenticatedUsername,
      github: this.github,
    });
    this.cachedAuthenticatedUsername = cache;
    return username;
  }

  private determineRatchetState(pr: PRStateInfo): RatchetState {
    return determineRatchetStateHelper(pr);
  }

  private async triggerFixer(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo
  ): Promise<RatchetAction> {
    return await triggerRatchetFixer({
      workspace,
      prStateInfo,
      sessionBridge: this.session,
      setActiveSession: (workspaceId, sessionId) => this.setActiveSession(workspaceId, sessionId),
      clearActiveSession: (workspaceId) => this.clearActiveSession(workspaceId),
      logger,
    });
  }

  private async setActiveSession(workspaceId: string, sessionId: string): Promise<void> {
    await workspaceAccessor.update(workspaceId, { ratchetActiveSessionId: sessionId });
  }

  private async clearActiveSession(workspaceId: string): Promise<void> {
    await workspaceAccessor.update(workspaceId, { ratchetActiveSessionId: null });
  }

  private async resetDispatchState(workspaceId: string): Promise<void> {
    await workspaceAccessor.update(workspaceId, {
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
    });
  }
}

export const ratchetService = new RatchetService();
