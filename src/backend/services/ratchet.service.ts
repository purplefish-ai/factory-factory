/**
 * Ratchet Service
 *
 * Simplified ratchet loop:
 * - Poll workspaces with PRs
 * - Evaluate whether the PR is open and needs attention
 * - Dispatch a single ratchet agent only when workspace is idle
 */

import { CIStatus, RatchetState } from '@prisma-gen/client';
import pLimit from 'p-limit';
import type { PRWithFullDetails } from '@/shared/github-types';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { userSettingsAccessor } from '../resource_accessors/user-settings.accessor';
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

export interface RatchetSettings {
  autoFixCi: boolean;
  autoFixReviews: boolean;
  autoMerge: boolean;
  allowedReviewers: string[];
}

export interface PRStateInfo {
  ciStatus: CIStatus;
  mergeStateStatus: string;
  hasChangesRequested: boolean;
  hasNewReviewComments: boolean;
  failedChecks: Array<{
    name: string;
    conclusion: string;
    detailsUrl?: string;
  }>;
  ciRunId: string | null;
  reviews: PRWithFullDetails['reviews'];
  comments: PRWithFullDetails['comments'];
  reviewComments: Array<{
    id: number;
    author: { login: string };
    body: string;
    path: string;
    line: number | null;
    createdAt: string;
    url: string;
  }>;
  newReviewComments: Array<{
    id: number;
    author: { login: string };
    body: string;
    path: string;
    line: number | null;
    createdAt: string;
    url: string;
  }>;
  newPRComments: PRWithFullDetails['comments'];
  prState: string;
  prNumber: number;
}

export type RatchetAction =
  | { type: 'WAITING'; reason: string }
  | { type: 'FIXER_ACTIVE'; sessionId: string }
  | { type: 'TRIGGERED_FIXER'; sessionId: string; fixerType: string; promptSent: boolean }
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

interface AttentionStatus {
  ciNeedsAttention: boolean;
  reviewNeedsAttention: boolean;
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

    const userSettings = await userSettingsAccessor.get();
    const settings: RatchetSettings = {
      autoFixCi: userSettings.ratchetAutoFixCi,
      autoFixReviews: userSettings.ratchetAutoFixReviews,
      autoMerge: userSettings.ratchetAutoMerge,
      allowedReviewers: (userSettings.ratchetAllowedReviewers as string[]) ?? [],
    };

    const workspaces = await workspaceAccessor.findWithPRsForRatchet();

    if (workspaces.length === 0) {
      return { checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] };
    }

    const results = await Promise.all(
      workspaces.map((workspace) =>
        this.checkLimit(() => this.processWorkspace(workspace, settings))
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

  async checkWorkspaceById(workspaceId: string): Promise<WorkspaceRatchetResult | null> {
    if (this.isShuttingDown) {
      return null;
    }

    const workspace = await workspaceAccessor.findForRatchetById(workspaceId);
    if (!workspace) {
      return null;
    }

    const userSettings = await userSettingsAccessor.get();
    const settings: RatchetSettings = {
      autoFixCi: userSettings.ratchetAutoFixCi,
      autoFixReviews: userSettings.ratchetAutoFixReviews,
      autoMerge: userSettings.ratchetAutoMerge,
      allowedReviewers: (userSettings.ratchetAllowedReviewers as string[]) ?? [],
    };

    return this.processWorkspace(workspace, settings);
  }

  private async processWorkspace(
    workspace: WorkspaceWithPR,
    settings: RatchetSettings
  ): Promise<WorkspaceRatchetResult> {
    if (this.isShuttingDown) {
      return {
        workspaceId: workspace.id,
        previousState: workspace.ratchetState,
        newState: workspace.ratchetState,
        action: { type: 'WAITING', reason: 'Shutting down' },
      };
    }

    try {
      const prStateInfo = await this.fetchPRState(workspace, settings.allowedReviewers);
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
        ? await this.evaluateAndDispatch(workspace, prStateInfo, settings)
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
    prStateInfo: PRStateInfo,
    settings: RatchetSettings
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

    const { ciNeedsAttention, reviewNeedsAttention } = this.getAttentionStatus(
      workspace,
      prStateInfo
    );

    if (!(ciNeedsAttention || reviewNeedsAttention)) {
      return { type: 'WAITING', reason: 'No actionable CI failures or review activity' };
    }

    const shouldFixCi = ciNeedsAttention && settings.autoFixCi;
    const shouldFixReviews = reviewNeedsAttention && settings.autoFixReviews;

    if (!(shouldFixCi || shouldFixReviews)) {
      return {
        type: 'DISABLED',
        reason: this.getDisabledReason(ciNeedsAttention, reviewNeedsAttention),
      };
    }

    const hasOtherActiveSession = await this.hasNonRatchetActiveSession(workspace.id);
    if (hasOtherActiveSession) {
      return {
        type: 'WAITING',
        reason: 'Workspace is not idle (active non-ratchet chat session)',
      };
    }

    return this.triggerFixer(workspace, prStateInfo, settings, {
      shouldFixCi,
      shouldFixReviews,
    });
  }

  private getAttentionStatus(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo
  ): AttentionStatus {
    return {
      ciNeedsAttention:
        prStateInfo.ciStatus === CIStatus.FAILURE &&
        !!prStateInfo.ciRunId &&
        prStateInfo.ciRunId !== workspace.ratchetLastCiRunId,
      reviewNeedsAttention: prStateInfo.hasChangesRequested || prStateInfo.hasNewReviewComments,
    };
  }

  private getDisabledReason(ciNeedsAttention: boolean, reviewNeedsAttention: boolean): string {
    if (ciNeedsAttention && reviewNeedsAttention) {
      return 'CI and review auto-fix disabled';
    }
    if (ciNeedsAttention) {
      return 'CI auto-fix disabled';
    }
    return 'Review auto-fix disabled';
  }

  private async updateWorkspaceAfterCheck(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    action: RatchetAction,
    nextState: RatchetState
  ): Promise<void> {
    const now = new Date();
    const { ciNeedsAttention, reviewNeedsAttention } = this.getAttentionStatus(
      workspace,
      prStateInfo
    );
    const dispatched = action.type === 'TRIGGERED_FIXER' && action.promptSent;

    await workspaceAccessor.update(workspace.id, {
      ratchetState: nextState,
      ratchetLastCheckedAt: now,
      ...(dispatched && ciNeedsAttention ? { ratchetLastCiRunId: prStateInfo.ciRunId } : {}),
      ...(dispatched && reviewNeedsAttention ? { prReviewLastCheckedAt: now } : {}),
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

    if (!sessionService.isSessionRunning(workspace.ratchetActiveSessionId)) {
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
      return sessionService.isSessionRunning(session.id);
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

  private hasChangesRequestedForAllowedReviewers(
    reviews: PRWithFullDetails['reviews'],
    allowedReviewers: string[],
    reviewDecision: PRWithFullDetails['reviewDecision']
  ): boolean {
    if (allowedReviewers.length === 0) {
      return reviewDecision === 'CHANGES_REQUESTED';
    }

    const latestByReviewer = new Map<string, { state: string; submittedAt: number }>();

    for (const review of reviews) {
      if (!allowedReviewers.includes(review.author.login)) {
        continue;
      }

      const submittedAtMs = new Date(review.submittedAt).getTime();
      const prev = latestByReviewer.get(review.author.login);
      if (!prev || submittedAtMs > prev.submittedAt) {
        latestByReviewer.set(review.author.login, {
          state: review.state,
          submittedAt: submittedAtMs,
        });
      }
    }

    return Array.from(latestByReviewer.values()).some((r) => r.state === 'CHANGES_REQUESTED');
  }

  private async fetchPRState(
    workspace: WorkspaceWithPR,
    allowedReviewers: string[]
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
          status: check.status,
          conclusion: check.conclusion ?? undefined,
        })) ?? null;

      const ciStatus = githubCLIService.computeCIStatus(statusCheckRollup);

      const failedChecks: PRStateInfo['failedChecks'] = [];
      if (prDetails.statusCheckRollup) {
        for (const check of prDetails.statusCheckRollup) {
          const conclusion = String(check.conclusion || check.status);
          if (
            conclusion === 'FAILURE' ||
            conclusion === 'ACTION_REQUIRED' ||
            conclusion === 'ERROR'
          ) {
            failedChecks.push({
              name: check.name || 'Unknown check',
              conclusion,
              detailsUrl: check.detailsUrl,
            });
          }
        }
      }
      const ciRunId = this.extractFailedCiSignature(failedChecks);

      const hasChangesRequested = this.hasChangesRequestedForAllowedReviewers(
        prDetails.reviews,
        allowedReviewers,
        prDetails.reviewDecision
      );

      const lastDispatchedAt = workspace.prReviewLastCheckedAt?.getTime() ?? 0;
      const filterByReviewer = allowedReviewers.length > 0;

      const newReviewComments = reviewComments.filter((comment) => {
        const createdTime = new Date(comment.createdAt).getTime();
        const updatedTime = new Date(comment.updatedAt).getTime();
        const isNewOrEdited = createdTime > lastDispatchedAt || updatedTime > lastDispatchedAt;
        const isAllowedReviewer =
          !filterByReviewer || allowedReviewers.includes(comment.author.login);
        return isNewOrEdited && isAllowedReviewer;
      });

      const newPRComments = prDetails.comments.filter((comment) => {
        const createdTime = new Date(comment.createdAt).getTime();
        const updatedTime = new Date(comment.updatedAt).getTime();
        const isNewOrEdited = createdTime > lastDispatchedAt || updatedTime > lastDispatchedAt;
        const isAllowedReviewer =
          !filterByReviewer || allowedReviewers.includes(comment.author.login);
        return isNewOrEdited && isAllowedReviewer;
      });

      const hasNewReviewComments = newReviewComments.length > 0 || newPRComments.length > 0;

      return {
        ciStatus,
        mergeStateStatus: prDetails.mergeStateStatus,
        hasChangesRequested,
        hasNewReviewComments,
        failedChecks,
        ciRunId,
        reviews: prDetails.reviews,
        comments: prDetails.comments,
        reviewComments,
        newReviewComments,
        newPRComments,
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

    if (pr.hasChangesRequested || pr.hasNewReviewComments) {
      return RatchetState.REVIEW_PENDING;
    }

    return RatchetState.READY;
  }

  private async triggerFixer(
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    settings: RatchetSettings,
    fixPlan: { shouldFixCi: boolean; shouldFixReviews: boolean }
  ): Promise<RatchetAction> {
    try {
      const result = await fixerSessionService.acquireAndDispatch({
        workspaceId: workspace.id,
        workflow: RATCHET_WORKFLOW,
        sessionName: 'Ratchet',
        runningIdleAction: 'restart',
        dispatchMode: 'start_empty_and_send',
        buildPrompt: () =>
          this.buildUnifiedRatchetPrompt(workspace.prUrl, prStateInfo, settings, fixPlan),
        beforeStart: ({ sessionId, prompt }) => {
          messageStateService.injectCommittedUserMessage(sessionId, prompt);
        },
      });

      if (result.status === 'started') {
        const promptSent = result.promptSent ?? true;
        await workspaceAccessor.update(workspace.id, {
          ratchetActiveSessionId: result.sessionId,
        });

        return {
          type: 'TRIGGERED_FIXER',
          sessionId: result.sessionId,
          fixerType: 'ratchet',
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

  private filterByAllowedReviewers<T extends { author: { login: string } }>(
    items: T[],
    allowedReviewers: string[]
  ): T[] {
    if (allowedReviewers.length === 0) {
      return items;
    }
    return items.filter((item) => allowedReviewers.includes(item.author.login));
  }

  private formatReviewsSection(reviews: PRStateInfo['reviews']): string {
    if (reviews.length === 0) {
      return '';
    }

    const lines = ['### Reviews Requesting Changes\n\n'];
    for (const review of reviews) {
      lines.push(
        `**${review.author.login}** (${new Date(review.submittedAt).toLocaleDateString()}):\n`
      );
      if (review.body) {
        lines.push(`> ${review.body.split('\n').join('\n> ')}\n`);
      }
      lines.push('\n');
    }
    return lines.join('');
  }

  private formatCodeCommentsSection(comments: PRStateInfo['reviewComments']): string {
    if (comments.length === 0) {
      return '';
    }

    const lines = ['### New Review Comments on Code\n\n'];
    for (const comment of comments) {
      const location = comment.line ? `:${comment.line}` : '';
      lines.push(`**${comment.author.login}** on \`${comment.path}\`${location}:\n`);
      lines.push(`> ${comment.body.split('\n').join('\n> ')}\n`);
      lines.push(`> [View comment](${comment.url})\n\n`);
    }
    return lines.join('');
  }

  private formatPRCommentsSection(comments: PRStateInfo['comments']): string {
    if (comments.length === 0) {
      return '';
    }

    const lines = ['### New PR Comments\n\n'];
    for (const comment of comments) {
      lines.push(
        `**${comment.author.login}** (${new Date(comment.createdAt).toLocaleDateString()}):\n`
      );
      lines.push(`> ${comment.body.split('\n').join('\n> ')}\n\n`);
    }
    return lines.join('');
  }

  private buildUnifiedRatchetPrompt(
    prUrl: string,
    prStateInfo: PRStateInfo,
    settings: RatchetSettings,
    fixPlan: { shouldFixCi: boolean; shouldFixReviews: boolean }
  ): string {
    const parts: string[] = [
      `## Ratchet Attention Required\n\nPR #${prStateInfo.prNumber} needs automated attention.\n\n**PR URL:** ${prUrl}\n\n`,
    ];

    if (fixPlan.shouldFixCi) {
      parts.push('### CI Failures\n\n');
      if (prStateInfo.failedChecks.length > 0) {
        for (const check of prStateInfo.failedChecks) {
          parts.push(`- **${check.name}**: ${check.conclusion}`);
          if (check.detailsUrl) {
            parts.push(` ([logs](${check.detailsUrl}))`);
          }
          parts.push('\n');
        }
      } else {
        parts.push('- CI reports failure but no failed check details were returned.\n');
      }
      parts.push('\n');
    }

    if (fixPlan.shouldFixReviews) {
      const changesRequestedReviews = prStateInfo.reviews.filter(
        (r) => r.state === 'CHANGES_REQUESTED'
      );
      const filteredReviews = this.filterByAllowedReviewers(
        changesRequestedReviews,
        settings.allowedReviewers
      );

      parts.push(this.formatReviewsSection(filteredReviews));
      parts.push(this.formatCodeCommentsSection(prStateInfo.newReviewComments));
      parts.push(this.formatPRCommentsSection(prStateInfo.newPRComments));
    }

    parts.push(`### Instructions

1. Sync with main first:
   \`\`\`bash
   git fetch origin && git merge origin/main
   \`\`\`
   Resolve conflicts as part of this fix.

2. Address all requested work in this run:
   - Fix CI failures (if any)
   - Address review feedback (if any)

3. Verify locally:
   \`\`\`bash
   pnpm test && pnpm typecheck && pnpm check:fix
   \`\`\`

4. Commit and push your changes.

5. If review feedback was addressed, request re-review on the PR.

Operate autonomously. Do not ask the user for confirmation.`);

    return parts.join('');
  }

  private extractFailedCiSignature(failedChecks: PRStateInfo['failedChecks']): string | null {
    if (failedChecks.length === 0) {
      return null;
    }

    const failedEntries: string[] = [];
    for (const check of failedChecks) {
      const runIdMatch = check.detailsUrl?.match(/\/actions\/runs\/(\d+)/);
      const runId = runIdMatch?.[1] ?? 'no-run-id';
      failedEntries.push(`${check.name}:${runId}`);
    }

    if (failedEntries.length === 0) {
      return null;
    }

    return failedEntries.sort().join('|');
  }
}

export const ratchetService = new RatchetService();
