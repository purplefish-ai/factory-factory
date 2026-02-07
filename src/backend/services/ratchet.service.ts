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

interface PRStateInfo {
  ciStatus: CIStatus;
  ciSignature: string;
  latestActivityAtMs: number;
  hasChangesRequested: boolean;
  prState: string;
  prNumber: number;
}

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
      const prStateInfo = await this.fetchPRState(workspace);
      if (!prStateInfo) {
        return {
          workspaceId: workspace.id,
          previousState: workspace.ratchetState,
          newState: workspace.ratchetState,
          action: { type: 'ERROR', error: 'Failed to fetch PR state' },
        };
      }

      const previousState = workspace.ratchetState;
      const newState = this.determineRatchetState(prStateInfo);

      const latestWorkspace = await workspaceAccessor.findById(workspace.id);
      const shouldTakeAction = latestWorkspace?.ratchetEnabled ?? workspace.ratchetEnabled;

      const action = shouldTakeAction
        ? await this.evaluateAndDispatch(workspace, prStateInfo)
        : { type: 'DISABLED' as const, reason: 'Workspace ratcheting disabled' };

      await this.updateWorkspaceAfterCheck(
        workspace,
        prStateInfo,
        action,
        shouldTakeAction ? newState : RatchetState.IDLE
      );

      return {
        workspaceId: workspace.id,
        previousState,
        newState: shouldTakeAction ? newState : RatchetState.IDLE,
        action,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error processing workspace in ratchet', error as Error, {
        workspaceId: workspace.id,
      });
      return {
        workspaceId: workspace.id,
        previousState: workspace.ratchetState,
        newState: workspace.ratchetState,
        action: { type: 'ERROR', error: errorMessage },
      };
    }
  }

  private async evaluateAndDispatch(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo
  ): Promise<RatchetAction> {
    if (prStateInfo.prState === 'MERGED') {
      return { type: 'COMPLETED' };
    }

    if (prStateInfo.prState !== 'OPEN') {
      return { type: 'WAITING', reason: 'PR is not open' };
    }

    const activeRatchetSession = await this.getActiveRatchetSession(workspace);
    if (activeRatchetSession) {
      return activeRatchetSession;
    }

    if (!this.hasStateChangedSinceLastDispatch(workspace, prStateInfo)) {
      return { type: 'WAITING', reason: 'PR state unchanged since last ratchet dispatch' };
    }

    const hasOtherActiveSession = await this.hasNonRatchetActiveSession(workspace.id);
    if (hasOtherActiveSession) {
      return {
        type: 'WAITING',
        reason: 'Workspace is not idle (active non-ratchet chat session)',
      };
    }

    return this.triggerFixer(workspace, prStateInfo);
  }

  private hasStateChangedSinceLastDispatch(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo
  ): boolean {
    const ciChanged = workspace.ratchetLastCiRunId !== prStateInfo.ciSignature;

    if (!workspace.prReviewLastCheckedAt) {
      return true;
    }

    const reviewChanged =
      prStateInfo.latestActivityAtMs > workspace.prReviewLastCheckedAt.getTime();
    return ciChanged || reviewChanged;
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
            ratchetLastCiRunId: prStateInfo.ciSignature,
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

  private computeLatestActivityTimestamp(
    prDetails: {
      reviews: Array<{ submittedAt: string }>;
      comments: Array<{ updatedAt: string }>;
    },
    reviewComments: Array<{ updatedAt: string }>
  ): number {
    const timestamps: number[] = [];

    for (const review of prDetails.reviews) {
      timestamps.push(new Date(review.submittedAt).getTime());
    }
    for (const comment of prDetails.comments) {
      timestamps.push(new Date(comment.updatedAt).getTime());
    }
    for (const reviewComment of reviewComments) {
      timestamps.push(new Date(reviewComment.updatedAt).getTime());
    }

    return timestamps.length > 0 ? Math.max(...timestamps) : 0;
  }

  private computeCiSignature(
    ciStatus: CIStatus,
    failedChecks: Array<{ name: string; detailsUrl?: string }>
  ): string {
    if (ciStatus !== CIStatus.FAILURE) {
      return `status:${ciStatus}`;
    }

    const failedEntries: string[] = [];
    for (const check of failedChecks) {
      const runIdMatch = check.detailsUrl?.match(/\/actions\/runs\/(\d+)/);
      const runId = runIdMatch?.[1] ?? 'no-run-id';
      failedEntries.push(`${check.name}:${runId}`);
    }

    if (failedEntries.length === 0) {
      return 'status:FAILURE:no-check-signature';
    }

    return `status:FAILURE:${failedEntries.sort().join('|')}`;
  }

  private async fetchPRState(workspace: WorkspaceWithPR): Promise<PRStateInfo | null> {
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
          status: check.status,
          conclusion: check.conclusion ?? undefined,
        })) ?? null;

      const ciStatus = githubCLIService.computeCIStatus(statusCheckRollup);

      const failedChecks =
        prDetails.statusCheckRollup?.filter((check) => {
          const conclusion = String(check.conclusion || check.status);
          return (
            conclusion === 'FAILURE' || conclusion === 'ACTION_REQUIRED' || conclusion === 'ERROR'
          );
        }) ?? [];

      const ciSignature = this.computeCiSignature(
        ciStatus,
        failedChecks.map((check) => ({
          name: check.name || 'Unknown check',
          detailsUrl: check.detailsUrl,
        }))
      );

      const hasChangesRequested = prDetails.reviewDecision === 'CHANGES_REQUESTED';
      const latestActivityAtMs = this.computeLatestActivityTimestamp(prDetails, reviewComments);

      return {
        ciStatus,
        ciSignature,
        latestActivityAtMs,
        hasChangesRequested,
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
        buildPrompt: () => this.buildDispatchPrompt(workspace.prUrl, prStateInfo.prNumber),
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

  private buildDispatchPrompt(prUrl: string, prNumber: number): string {
    return `PR #${prNumber} has changed since the last ratchet run.

PR URL: ${prUrl}

Execute autonomously in this order:
1. First merge in the latest main and fix any conflicts.
2. Check for CI failures.
3. Check for any unaddressed code review comments.
4. Build/lint/test.
5. Push your changes.
6. Comment briefly on and resolve the addressed code review comments.

Do not ask for confirmation.`;
  }
}

export const ratchetService = new RatchetService();
