/**
 * Ratchet Service
 *
 * Simplified ratchet loop:
 * - Poll workspaces with PRs
 * - Dispatch ratchet only when PR state changed since last dispatch
 * - Dispatch only when workspace is idle (no active ratchet or other chat session)
 */

import { EventEmitter } from 'node:events';
import type { SessionProvider } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { buildRatchetDispatchPrompt } from '@/backend/prompts/ratchet-dispatch';
import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import {
  SERVICE_CACHE_TTL_MS,
  SERVICE_CONCURRENCY,
  SERVICE_INTERVAL_MS,
  SERVICE_THRESHOLDS,
  SERVICE_TIMEOUT_MS,
} from '@/backend/services/constants';
import { createLogger } from '@/backend/services/logger.service';
import { RateLimitBackoff } from '@/backend/services/rate-limit-backoff';
import { CIStatus, RatchetState, SessionStatus } from '@/shared/core';
import type { RatchetGitHubBridge, RatchetPRSnapshotBridge, RatchetSessionBridge } from './bridges';
import { fixerSessionService } from './fixer-session.service';
import { ratchetProviderResolverService } from './ratchet-provider-resolver.service';

const logger = createLogger('ratchet');

const RATCHET_WORKFLOW = 'ratchet';

/** Interval (ms) between review comment re-polls while PR is open and clean. */
const REVIEW_POLL_INTERVAL_MS = 2 * 60_000; // 2 min

interface ReviewPollTracker {
  snapshotKey: string;
  lastPolledAt: number;
  pollCount: number;
}

type ReviewPollResult =
  | { action: 'waiting' }
  | { action: 'comments-found'; freshPrState: PRStateInfo };

interface PRStateInfo {
  ciStatus: CIStatus;
  snapshotKey: string;
  hasChangesRequested: boolean;
  latestReviewActivityAtMs: number | null;
  statusCheckRollup: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
    detailsUrl?: string;
  }> | null;
  prState: string;
  prNumber: number;
  reviewComments: Array<{
    author: string;
    body: string;
    path: string;
    line: number | null;
    url: string;
  }>;
}

interface RatchetDecisionContext {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  previousState: RatchetState;
  newState: RatchetState;
  finalState: RatchetState;
  hasNewReviewActivitySinceLastDispatch: boolean;
  hasStateChangedSinceLastDispatch: boolean;
  isCleanPrWithNoNewReviewActivity: boolean;
  activeRatchetSession: RatchetAction | null;
  hasOtherActiveSession: boolean;
}

type RatchetDecision = { type: 'RETURN_ACTION'; action: RatchetAction } | { type: 'TRIGGER_FIXER' };

export type RatchetAction =
  | { type: 'WAITING'; reason: string }
  | { type: 'FIXER_ACTIVE'; sessionId: string }
  | { type: 'TRIGGERED_FIXER'; sessionId: string; promptSent: boolean }
  | { type: 'DISABLED'; reason: string }
  | { type: 'COMPLETED' }
  | { type: 'ERROR'; error: string };

export interface WorkspaceRatchetResult {
  workspaceId: string;
  previousState: RatchetState;
  newState: RatchetState;
  action: RatchetAction;
}

export interface RatchetCheckResult {
  checked: number;
  stateChanges: number;
  actionsTriggered: number;
  results: WorkspaceRatchetResult[];
}

type WorkspaceWithPR = NonNullable<
  Awaited<ReturnType<typeof workspaceAccessor.findForRatchetById>>
>;

export const RATCHET_STATE_CHANGED = 'ratchet_state_changed' as const;

export interface RatchetStateChangedEvent {
  workspaceId: string;
  fromState: RatchetState;
  toState: RatchetState;
}

class RatchetService extends EventEmitter {
  private isShuttingDown = false;
  private monitorLoop: Promise<void> | null = null;
  private sleepTimeout: NodeJS.Timeout | null = null;
  private sleepResolve: (() => void) | null = null;
  private workspaceCheckTimeoutMs = SERVICE_TIMEOUT_MS.ratchetWorkspaceCheck;
  private readonly checkLimit = pLimit(SERVICE_CONCURRENCY.ratchetWorkspaceChecks);
  private readonly inFlightWorkspaceChecks = new Map<string, Promise<WorkspaceRatchetResult>>();
  private cachedAuthenticatedUsername: { value: string | null; expiresAtMs: number } | null = null;
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
      logger.error('Ratchet workspace check failed', error as Error, {
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
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
      return;
    }

    const activeSessionId = workspace.ratchetActiveSessionId;
    if (activeSessionId && this.session.isSessionRunning(activeSessionId)) {
      await this.safeStopSession(
        activeSessionId,
        'Failed to stop active ratchet session while disabling ratchet',
        {
          workspaceId,
          sessionId: activeSessionId,
        }
      );
    }

    await workspaceAccessor.update(workspaceId, {
      ratchetEnabled: false,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
    });
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
    if (!prStateInfo) {
      return {
        ciSnapshotKey: null,
        snapshotComparison: null,
      };
    }

    return {
      ciSnapshotKey: this.computeCiSnapshotKey(prStateInfo.ciStatus, prStateInfo.statusCheckRollup),
      snapshotComparison: {
        previousDispatchSnapshotKey: workspace.ratchetLastCiRunId,
        currentSnapshotKey: prStateInfo.snapshotKey,
        changedSinceLastDispatch:
          decisionContext?.hasStateChangedSinceLastDispatch ??
          this.hasStateChangedSinceLastDispatch(workspace, prStateInfo),
      },
    };
  }

  private buildReviewTimestampDiagnostics(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo | null,
    decisionContext: RatchetDecisionContext | null
  ) {
    const latestReviewActivityAtMs = prStateInfo?.latestReviewActivityAtMs ?? null;
    const prReviewLastCheckedAtMs = workspace.prReviewLastCheckedAt?.getTime() ?? null;
    const deltaMs =
      latestReviewActivityAtMs !== null && prReviewLastCheckedAtMs !== null
        ? latestReviewActivityAtMs - prReviewLastCheckedAtMs
        : null;

    if (!prStateInfo) {
      return {
        latestReviewActivityAtMs,
        reviewTimestampComparison: null,
      };
    }

    return {
      latestReviewActivityAtMs,
      reviewTimestampComparison: {
        prReviewLastCheckedAt: workspace.prReviewLastCheckedAt?.toISOString() ?? null,
        latestReviewActivityAt:
          latestReviewActivityAtMs !== null
            ? new Date(latestReviewActivityAtMs).toISOString()
            : null,
        prReviewLastCheckedAtMs,
        latestReviewActivityAtMs,
        deltaMs,
        hasNewReviewActivitySinceLastDispatch:
          decisionContext?.hasNewReviewActivitySinceLastDispatch !== undefined
            ? decisionContext.hasNewReviewActivitySinceLastDispatch
            : this.hasNewReviewActivitySinceLastDispatch(workspace, prStateInfo),
      },
    };
  }

  private buildFailedCheckDiagnostics(prStateInfo: PRStateInfo | null) {
    return (
      prStateInfo?.statusCheckRollup
        ?.filter((check) => {
          const conclusion = check.conclusion?.toUpperCase();
          return (
            conclusion === 'FAILURE' ||
            conclusion === 'TIMED_OUT' ||
            conclusion === 'CANCELLED' ||
            conclusion === 'ERROR' ||
            conclusion === 'ACTION_REQUIRED'
          );
        })
        .map((check) => {
          const runIdMatch = check.detailsUrl?.match(/\/actions\/runs\/(\d+)/);
          return {
            name: check.name ?? 'unknown',
            status: check.status ?? null,
            conclusion: check.conclusion ?? null,
            runId: runIdMatch?.[1] ?? null,
            detailsUrl: check.detailsUrl ?? null,
          };
        }) ?? []
    );
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

  private shouldSkipCleanPR(workspace: WorkspaceWithPR, prStateInfo: PRStateInfo): boolean {
    if (prStateInfo.ciStatus !== CIStatus.SUCCESS || prStateInfo.hasChangesRequested) {
      return false;
    }

    return !this.hasNewReviewActivitySinceLastDispatch(workspace, prStateInfo);
  }

  private hasNewReviewActivitySinceLastDispatch(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo
  ): boolean {
    if (prStateInfo.latestReviewActivityAtMs === null) {
      return false;
    }

    if (!workspace.prReviewLastCheckedAt) {
      return true;
    }

    if (prStateInfo.latestReviewActivityAtMs > workspace.prReviewLastCheckedAt.getTime()) {
      return true;
    }

    // Self-heal: if the review check timestamp is stale and there's no active fixer session,
    // treat as new activity so the ratchet re-evaluates. This catches edge cases where a
    // dispatch was recorded but the session died through an unanticipated path.
    if (!workspace.ratchetActiveSessionId) {
      const age = Date.now() - workspace.prReviewLastCheckedAt.getTime();
      if (age > SERVICE_THRESHOLDS.ratchetReviewCheckStaleMs) {
        logger.info(
          'Review check timestamp is stale with no active session, treating as new activity',
          {
            workspaceId: workspace.id,
            checkedAtAge: Math.round(age / 1000),
          }
        );
        return true;
      }
    }

    return false;
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

    if (pollResult.action === 'comments-found') {
      const freshContext = await this.buildRatchetDecisionContext(
        workspace,
        pollResult.freshPrState
      );
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

    return null;
  }

  private async handleReviewCommentPoll(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    authenticatedUsername: string | null
  ): Promise<ReviewPollResult> {
    const existing = this.reviewPollTrackers.get(workspace.id);

    if (!existing) {
      this.reviewPollTrackers.set(workspace.id, {
        snapshotKey: prStateInfo.snapshotKey,
        lastPolledAt: Date.now(),
        pollCount: 0,
      });
      logger.info('Started review comment polling', {
        workspaceId: workspace.id,
        snapshotKey: prStateInfo.snapshotKey,
      });
      return { action: 'waiting' };
    }

    if (existing.snapshotKey !== prStateInfo.snapshotKey) {
      this.reviewPollTrackers.set(workspace.id, {
        snapshotKey: prStateInfo.snapshotKey,
        lastPolledAt: Date.now(),
        pollCount: 0,
      });
      logger.info('Reset review comment polling (new snapshot)', {
        workspaceId: workspace.id,
        snapshotKey: prStateInfo.snapshotKey,
      });
      return { action: 'waiting' };
    }

    if (Date.now() - existing.lastPolledAt < REVIEW_POLL_INTERVAL_MS) {
      return { action: 'waiting' };
    }

    if (this.isShuttingDown) {
      return { action: 'waiting' };
    }

    const freshPrState = await this.fetchPRState(workspace, authenticatedUsername);

    if (!freshPrState) {
      return { action: 'waiting' };
    }

    existing.pollCount++;
    existing.lastPolledAt = Date.now();

    if (!this.shouldSkipCleanPR(workspace, freshPrState)) {
      this.reviewPollTrackers.delete(workspace.id);
      logger.info('Review comments detected during poll', {
        workspaceId: workspace.id,
        pollNumber: existing.pollCount,
        latestReviewActivityAtMs: freshPrState.latestReviewActivityAtMs,
      });
      return { action: 'comments-found', freshPrState };
    }

    return { action: 'waiting' };
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
    if (!workspace.ratchetActiveSessionId) {
      return null;
    }

    const resolvedRatchetProvider = await ratchetProviderResolverService.resolveRatchetProvider({
      workspaceId: workspace.id,
      workspace,
    });
    const session = await agentSessionAccessor.findById(workspace.ratchetActiveSessionId);
    if (!session) {
      await this.clearFailedRatchetDispatch(workspace, 'session not found in database');
      return null;
    }

    if (session.provider !== resolvedRatchetProvider) {
      await this.clearFailedRatchetDispatch(
        workspace,
        `provider mismatch: expected ${resolvedRatchetProvider}, got ${session.provider}`
      );
      await this.stopSessionForProviderMismatch(
        workspace.id,
        session.id,
        resolvedRatchetProvider,
        session.provider
      );
      return null;
    }

    if (session.status !== SessionStatus.RUNNING) {
      await this.clearFailedRatchetDispatch(workspace, `session status is ${session.status}`);
      return null;
    }

    if (!this.session.isSessionRunning(session.id)) {
      await this.clearFailedRatchetDispatch(workspace, 'session process is not running');
      return null;
    }

    // Ratchet session has completed its current unit of work: close it to avoid lingering idle agents.
    if (!this.session.isSessionWorking(session.id)) {
      await this.clearActiveRatchetSession(workspace.id);
      await this.stopCompletedRatchetSession(workspace.id, session.id);
      return null;
    }

    return { type: 'FIXER_ACTIVE', sessionId: workspace.ratchetActiveSessionId };
  }

  /**
   * Clear a ratchet session that died without completing its work.
   * Resets dispatch tracking so the next poll cycle re-evaluates and re-dispatches.
   */
  private async clearFailedRatchetDispatch(
    workspace: WorkspaceWithPR,
    reason: string
  ): Promise<void> {
    logger.info('Clearing failed ratchet dispatch, resetting state for retry', {
      workspaceId: workspace.id,
      sessionId: workspace.ratchetActiveSessionId,
      reason,
    });
    await workspaceAccessor.update(workspace.id, {
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
    });
    await this.snapshot.recordReviewCheck(workspace.id, null);
  }

  private async hasActiveSession(workspaceId: string): Promise<boolean> {
    const sessions = await agentSessionAccessor.findByWorkspaceId(workspaceId);
    return sessions.some((session) => this.session.isSessionWorking(session.id));
  }

  private async clearActiveRatchetSession(workspaceId: string): Promise<void> {
    await workspaceAccessor.update(workspaceId, { ratchetActiveSessionId: null });
  }

  private async safeStopSession(
    sessionId: string,
    warningMessage: string,
    warningContext: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.session.stopSession(sessionId);
    } catch (error) {
      logger.warn(warningMessage, {
        ...warningContext,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopCompletedRatchetSession(workspaceId: string, sessionId: string): Promise<void> {
    await this.safeStopSession(sessionId, 'Failed to stop completed ratchet session', {
      workspaceId,
      sessionId,
    });
  }

  private async stopSessionForProviderMismatch(
    workspaceId: string,
    sessionId: string,
    expectedProvider: SessionProvider,
    actualProvider: SessionProvider
  ): Promise<void> {
    await this.safeStopSession(sessionId, 'Failed to stop mismatched ratchet provider session', {
      workspaceId,
      sessionId,
      expectedProvider,
      actualProvider,
    });
  }

  private resolveRatchetPrContext(
    workspace: WorkspaceWithPR
  ): { repo: string; prNumber: number } | null {
    const prInfo = this.github.extractPRInfo(workspace.prUrl);
    if (!prInfo) {
      logger.warn('Could not parse PR URL', { prUrl: workspace.prUrl });
      return null;
    }

    const prNumber = workspace.prNumber ?? prInfo.number;
    if (!prNumber) {
      logger.warn('Could not determine PR number for ratchet check', {
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
      });
      return null;
    }

    return {
      repo: `${prInfo.owner}/${prInfo.repo}`,
      prNumber,
    };
  }

  private async fetchPRState(
    workspace: WorkspaceWithPR,
    authenticatedUsername: string | null
  ): Promise<PRStateInfo | null> {
    const prContext = this.resolveRatchetPrContext(workspace);
    if (!prContext) {
      return null;
    }

    try {
      const [prDetails, reviewComments] = await Promise.all([
        this.github.getPRFullDetails(prContext.repo, prContext.prNumber),
        this.github.getReviewComments(prContext.repo, prContext.prNumber),
      ]);

      const statusCheckRollup =
        prDetails.statusCheckRollup?.map((check) => ({
          name: check.name,
          status: check.status,
          conclusion: check.conclusion ?? undefined,
          detailsUrl: check.detailsUrl,
        })) ?? null;

      const ciStatus = this.github.computeCIStatus(statusCheckRollup);

      const hasChangesRequested = prDetails.reviewDecision === 'CHANGES_REQUESTED';
      const latestReviewActivityAtMs = this.computeLatestReviewActivityAtMs(
        prDetails,
        reviewComments,
        authenticatedUsername
      );
      const snapshotKey = this.computeDispatchSnapshotKey(
        ciStatus,
        hasChangesRequested,
        latestReviewActivityAtMs,
        statusCheckRollup
      );

      const filteredReviewComments = reviewComments
        .filter((c) => !this.isIgnoredReviewAuthor(c.author.login, authenticatedUsername))
        .map((c) => ({
          author: c.author.login,
          body: c.body,
          path: c.path,
          line: c.line,
          url: c.url,
        }));

      return {
        ciStatus,
        snapshotKey,
        hasChangesRequested,
        latestReviewActivityAtMs,
        statusCheckRollup,
        prState: prDetails.state,
        prNumber: prDetails.number,
        reviewComments: filteredReviewComments,
      };
    } catch (error) {
      this.backoff.handleError(
        error,
        logger,
        'Ratchet',
        { workspaceId: workspace.id, prUrl: workspace.prUrl },
        SERVICE_INTERVAL_MS.ratchetPoll
      );
      return null;
    }
  }

  private computeDispatchSnapshotKey(
    ciStatus: CIStatus,
    hasChangesRequested: boolean,
    latestReviewActivityAtMs: number | null,
    statusChecks: Array<{
      name?: string;
      status?: string;
      conclusion?: string | null;
      detailsUrl?: string;
    }> | null
  ): string {
    const ciKey = this.computeCiSnapshotKey(ciStatus, statusChecks);
    const reviewKey = `${hasChangesRequested ? 'changes-requested' : 'no-changes-requested'}:${
      latestReviewActivityAtMs ?? 'none'
    }`;
    return `${ciKey}|${reviewKey}`;
  }

  private computeCiSnapshotKey(
    ciStatus: CIStatus,
    statusChecks: Array<{
      name?: string;
      status?: string;
      conclusion?: string | null;
      detailsUrl?: string;
    }> | null
  ): string {
    if (ciStatus !== CIStatus.FAILURE) {
      return `ci:${ciStatus}`;
    }

    const failedChecks =
      statusChecks?.filter((check) => {
        const conclusion = check.conclusion?.toUpperCase();
        return (
          conclusion === 'FAILURE' ||
          conclusion === 'TIMED_OUT' ||
          conclusion === 'CANCELLED' ||
          conclusion === 'ERROR' ||
          conclusion === 'ACTION_REQUIRED'
        );
      }) ?? [];

    if (failedChecks.length === 0) {
      return 'ci:FAILURE:unknown';
    }

    const signature = failedChecks
      .map((check) => {
        const runIdMatch = check.detailsUrl?.match(/\/actions\/runs\/(\d+)/);
        const runId = runIdMatch?.[1];
        const stableCheckIdentity = runId ?? check.detailsUrl ?? 'no-run-id-or-details-url';
        return `${check.name ?? 'unknown'}:${check.conclusion ?? 'UNKNOWN'}:${stableCheckIdentity}`;
      })
      .sort()
      .join('|');

    return `ci:FAILURE:${signature}`;
  }

  private computeLatestReviewActivityAtMs(
    prDetails: {
      reviews: Array<{ submittedAt: string | null; author: { login: string } }>;
      comments: Array<{ updatedAt: string; author: { login: string } }>;
    },
    reviewComments: Array<{ updatedAt: string; author: { login: string } }>,
    authenticatedUsername: string | null
  ): number | null {
    const entries = [
      ...prDetails.reviews.map((review) => ({
        authorLogin: review.author.login,
        timestamp: review.submittedAt,
      })),
      ...prDetails.comments.map((comment) => ({
        authorLogin: comment.author.login,
        timestamp: comment.updatedAt,
      })),
      ...reviewComments.map((reviewComment) => ({
        authorLogin: reviewComment.author.login,
        timestamp: reviewComment.updatedAt,
      })),
    ];

    const timestamps = entries
      .filter(
        (entry): entry is { authorLogin: string; timestamp: string } =>
          entry.timestamp !== null &&
          !this.isIgnoredReviewAuthor(entry.authorLogin, authenticatedUsername)
      )
      .map((entry) => Date.parse(entry.timestamp))
      .filter((timestamp) => Number.isFinite(timestamp));

    return timestamps.length > 0 ? Math.max(...timestamps) : null;
  }

  private isIgnoredReviewAuthor(
    authorLogin: string,
    authenticatedUsername: string | null
  ): boolean {
    if (!authenticatedUsername) {
      return false;
    }
    return authorLogin === authenticatedUsername;
  }

  private async getAuthenticatedUsernameCached(): Promise<string | null> {
    const nowMs = Date.now();
    if (this.cachedAuthenticatedUsername && this.cachedAuthenticatedUsername.expiresAtMs > nowMs) {
      return this.cachedAuthenticatedUsername.value;
    }

    const username = await this.github.getAuthenticatedUsername();
    this.cachedAuthenticatedUsername = {
      value: username,
      expiresAtMs: nowMs + SERVICE_CACHE_TTL_MS.ratchetAuthenticatedUsername,
    };
    return username;
  }

  private determineRatchetState(pr: PRStateInfo): RatchetState {
    if (pr.prState === 'MERGED') {
      return RatchetState.MERGED;
    }

    if (pr.prState !== 'OPEN') {
      return RatchetState.IDLE;
    }

    if (pr.ciStatus === CIStatus.PENDING || pr.ciStatus === CIStatus.UNKNOWN) {
      return RatchetState.CI_RUNNING;
    }

    if (pr.ciStatus === CIStatus.FAILURE) {
      return RatchetState.CI_FAILED;
    }

    if (pr.hasChangesRequested) {
      return RatchetState.REVIEW_PENDING;
    }

    return RatchetState.READY;
  }

  private async triggerFixer(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo
  ): Promise<RatchetAction> {
    try {
      const result = await fixerSessionService.acquireAndDispatch({
        workspaceId: workspace.id,
        workflow: RATCHET_WORKFLOW,
        sessionName: 'Ratchet',
        runningIdleAction: 'restart',
        dispatchMode: 'start_empty_and_send',
        buildPrompt: () =>
          buildRatchetDispatchPrompt(
            workspace.prUrl,
            prStateInfo.prNumber,
            prStateInfo.reviewComments
          ),
        beforeStart: ({ sessionId, prompt }) => {
          this.session.injectCommittedUserMessage(sessionId, prompt);
        },
      });

      if (result.status === 'started') {
        const promptSent = result.promptSent ?? true;
        if (!promptSent) {
          logger.warn('Ratchet session started but prompt delivery failed', {
            workspaceId: workspace.id,
            sessionId: result.sessionId,
          });
          await workspaceAccessor.update(workspace.id, { ratchetActiveSessionId: null });
          if (this.session.isSessionRunning(result.sessionId)) {
            await this.session.stopSession(result.sessionId);
          }
          return { type: 'ERROR', error: 'Failed to deliver initial ratchet prompt' };
        }

        await workspaceAccessor.update(workspace.id, {
          ratchetActiveSessionId: result.sessionId,
        });

        return {
          type: 'TRIGGERED_FIXER',
          sessionId: result.sessionId,
          promptSent,
        };
      }

      if (result.status === 'already_active') {
        await workspaceAccessor.update(workspace.id, { ratchetActiveSessionId: result.sessionId });
        return { type: 'FIXER_ACTIVE', sessionId: result.sessionId };
      }

      if (result.status === 'skipped') {
        return { type: 'ERROR', error: result.reason };
      }

      return { type: 'ERROR', error: result.error };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to trigger ratchet fixer', error as Error, {
        workspaceId: workspace.id,
      });
      return { type: 'ERROR', error: errorMessage };
    }
  }
}

export const ratchetService = new RatchetService();
