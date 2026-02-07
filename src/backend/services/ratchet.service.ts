/**
 * Ratchet Service
 *
 * Simplified ratchet loop:
 * - Poll workspaces with PRs
 * - Dispatch ratchet only when PR state changed since last dispatch
 * - Dispatch only when workspace is idle (no active ratchet or other chat session)
 */

import { CIStatus, RatchetState, SessionStatus } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { buildRatchetDispatchPrompt } from '../prompts/ratchet-dispatch';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { fixerSessionService } from './fixer-session.service';
import { githubCLIService } from './github-cli.service';
import { createLogger } from './logger.service';
import { messageStateService } from './message-state.service';
import { sessionService } from './session.service';

const logger = createLogger('ratchet');

const RATCHET_POLL_INTERVAL_MS = 60_000; // 1 minute
const MAX_CONCURRENT_CHECKS = 5;
const RATCHET_WORKFLOW = 'ratchet';
const AUTHENTICATED_USERNAME_CACHE_TTL_MS = 5 * 60_000;

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

interface WorkspaceWithPR {
  id: string;
  prUrl: string;
  prNumber: number | null;
  ratchetEnabled: boolean;
  ratchetState: RatchetState;
  ratchetActiveSessionId: string | null;
  ratchetLastCiRunId: string | null;
  prReviewLastCheckedAt: Date | null;
}

class RatchetService {
  private isShuttingDown = false;
  private monitorLoop: Promise<void> | null = null;
  private readonly checkLimit = pLimit(MAX_CONCURRENT_CHECKS);
  private cachedAuthenticatedUsername: { value: string | null; expiresAtMs: number } | null = null;

  start(): void {
    if (this.monitorLoop) {
      return;
    }

    this.isShuttingDown = false;
    this.monitorLoop = this.runContinuousLoop();

    logger.info('Ratchet service started', { intervalMs: RATCHET_POLL_INTERVAL_MS });
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.monitorLoop) {
      logger.debug('Waiting for ratchet monitor loop to complete');
      await this.monitorLoop;
      this.monitorLoop = null;
    }

    logger.info('Ratchet service stopped');
  }

  private async runContinuousLoop(): Promise<void> {
    while (!this.isShuttingDown) {
      try {
        await this.checkAllWorkspaces();
      } catch (err) {
        logger.error('Ratchet check failed', err as Error);
      }

      if (!this.isShuttingDown) {
        await this.sleep(RATCHET_POLL_INTERVAL_MS);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      workspaces.map((workspace) => this.checkLimit(() => this.processWorkspace(workspace)))
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

    return this.processWorkspace(workspace);
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
      const action = await this.applyRatchetDecision(decisionContext, decision);

      await this.updateWorkspaceAfterCheck(
        workspace,
        prStateInfo,
        action,
        decisionContext.finalState
      );
      this.logWorkspaceRatchetingDecision(
        workspace,
        decisionContext.previousState,
        decisionContext.finalState,
        action,
        prStateInfo
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
    prStateInfo: PRStateInfo | null
  ): void {
    const prNumber = prStateInfo?.prNumber ?? workspace.prNumber;
    const prNumberLabel = prNumber ?? 'unknown';
    const workspacePrPrefix = `workspace ${workspace.id} for PR #${prNumberLabel}`;
    const context = this.buildRatchetingDecisionContext(
      workspace,
      previousState,
      newState,
      action,
      prStateInfo,
      prNumber
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

  private buildRatchetingDecisionContext(
    workspace: WorkspaceWithPR,
    previousState: RatchetState,
    newState: RatchetState,
    action: RatchetAction,
    prStateInfo: PRStateInfo | null,
    prNumber: number | null
  ) {
    const reviewDiagnostics = this.buildReviewTimestampDiagnostics(workspace, prStateInfo);
    const snapshotDiagnostics = this.buildSnapshotDiagnostics(workspace, prStateInfo);
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

  private buildSnapshotDiagnostics(workspace: WorkspaceWithPR, prStateInfo: PRStateInfo | null) {
    if (!prStateInfo) {
      return {
        ciSnapshotKey: null,
        snapshotComparison: null,
      };
    }

    return {
      ciSnapshotKey: this.computeCiSnapshotKey(prStateInfo.ciStatus, prStateInfo.statusCheckRollup),
      snapshotComparison: {
        previousSnapshotKey: workspace.ratchetLastCiRunId,
        currentSnapshotKey: prStateInfo.snapshotKey,
        changedSinceLastDispatch: this.hasStateChangedSinceLastDispatch(workspace, prStateInfo),
      },
    };
  }

  private buildReviewTimestampDiagnostics(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo | null
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
        hasNewReviewActivitySinceLastDispatch: this.hasNewReviewActivitySinceLastDispatch(
          workspace,
          prStateInfo
        ),
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
      default:
        return 'No matching ratchet action';
    }
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
      isCleanPrWithNoNewReviewActivity
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
    isCleanPrWithNoNewReviewActivity: boolean
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

    return {
      activeRatchetSession: null,
      hasOtherActiveSession: await this.hasNonRatchetActiveSession(workspace.id),
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
          reason: 'Workspace is not idle (active non-ratchet chat session)',
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

    return prStateInfo.latestReviewActivityAtMs > workspace.prReviewLastCheckedAt.getTime();
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
            prReviewLastCheckedAt: now,
          }
        : {}),
    });
  }

  private async getActiveRatchetSession(workspace: WorkspaceWithPR): Promise<RatchetAction | null> {
    if (!workspace.ratchetActiveSessionId) {
      return null;
    }

    const session = await claudeSessionAccessor.findById(workspace.ratchetActiveSessionId);
    if (!session) {
      await workspaceAccessor.update(workspace.id, { ratchetActiveSessionId: null });
      return null;
    }

    if (session.status !== SessionStatus.RUNNING) {
      await workspaceAccessor.update(workspace.id, { ratchetActiveSessionId: null });
      return null;
    }

    if (!sessionService.isSessionRunning(session.id)) {
      await workspaceAccessor.update(workspace.id, { ratchetActiveSessionId: null });
      return null;
    }

    return { type: 'FIXER_ACTIVE', sessionId: workspace.ratchetActiveSessionId };
  }

  private async hasNonRatchetActiveSession(workspaceId: string): Promise<boolean> {
    const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId);
    return sessions.some((session) => {
      if (session.workflow === RATCHET_WORKFLOW) {
        return false;
      }
      return (
        session.status === SessionStatus.RUNNING || sessionService.isSessionRunning(session.id)
      );
    });
  }

  private resolveRatchetPrContext(
    workspace: WorkspaceWithPR
  ): { repo: string; prNumber: number } | null {
    const prInfo = githubCLIService.extractPRInfo(workspace.prUrl);
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
        githubCLIService.getPRFullDetails(prContext.repo, prContext.prNumber),
        githubCLIService.getReviewComments(prContext.repo, prContext.prNumber),
      ]);

      const statusCheckRollup =
        prDetails.statusCheckRollup?.map((check) => ({
          name: check.name,
          status: check.status,
          conclusion: check.conclusion ?? undefined,
          detailsUrl: check.detailsUrl,
        })) ?? null;

      const ciStatus = githubCLIService.computeCIStatus(statusCheckRollup);

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

      return {
        ciStatus,
        snapshotKey,
        hasChangesRequested,
        latestReviewActivityAtMs,
        statusCheckRollup,
        prState: prDetails.state,
        prNumber: prDetails.number,
      };
    } catch (error) {
      logger.error('Failed to fetch PR state', error as Error, {
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
      });
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
        const runId = runIdMatch?.[1] ?? 'no-run-id';
        return `${check.name ?? 'unknown'}:${check.conclusion ?? 'UNKNOWN'}:${runId}`;
      })
      .sort()
      .join('|');

    return `ci:FAILURE:${signature}`;
  }

  private computeLatestReviewActivityAtMs(
    prDetails: {
      reviews: Array<{ submittedAt: string; author: { login: string } }>;
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
      .filter((entry) => !this.isIgnoredReviewAuthor(entry.authorLogin, authenticatedUsername))
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

    const username = await githubCLIService.getAuthenticatedUsername();
    this.cachedAuthenticatedUsername = {
      value: username,
      expiresAtMs: nowMs + AUTHENTICATED_USERNAME_CACHE_TTL_MS,
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
        buildPrompt: () => buildRatchetDispatchPrompt(workspace.prUrl, prStateInfo.prNumber),
        beforeStart: ({ sessionId, prompt }) => {
          messageStateService.injectCommittedUserMessage(sessionId, prompt);
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
          if (sessionService.isSessionRunning(result.sessionId)) {
            await sessionService.stopClaudeSession(result.sessionId);
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
