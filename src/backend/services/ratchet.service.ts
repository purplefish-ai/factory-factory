/**
 * Ratchet Service
 *
 * Centralized PR progression system that replaces separate CI and PR review monitors.
 * Uses a state machine to continuously advance each PR toward merge by detecting
 * the current state and triggering the appropriate fixer action.
 *
 * States: IDLE → CI_RUNNING → CI_FAILED → MERGE_CONFLICT → REVIEW_PENDING → READY → MERGED
 */

import { CIStatus, RatchetState, SessionStatus } from '@prisma-gen/client';
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

// Workflow identifiers for fixer sessions
const RATCHET_WORKFLOW = 'ratchet';

export interface RatchetSettings {
  autoFixCi: boolean;
  autoFixConflicts: boolean;
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
  // Filtered to only NEW comments (since last check) and allowed reviewers
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
  | { type: 'NOTIFIED_ACTIVE_FIXER'; sessionId: string; issue: string }
  | { type: 'TRIGGERED_FIXER'; sessionId: string; fixerType: string; promptSent: boolean }
  | { type: 'DISABLED'; reason: string }
  | { type: 'READY_FOR_MERGE' }
  | { type: 'AUTO_MERGED' }
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
  ratchetLastNotifiedState: RatchetState | null;
  prReviewLastCheckedAt: Date | null;
}

class RatchetService {
  private isShuttingDown = false;
  private monitorLoop: Promise<void> | null = null;
  private readonly checkLimit = pLimit(MAX_CONCURRENT_CHECKS);

  /**
   * Start the ratchet monitor
   */
  start(): void {
    if (this.monitorLoop) {
      return; // Already running
    }

    this.isShuttingDown = false;
    this.monitorLoop = this.runContinuousLoop();

    logger.info('Ratchet service started', { intervalMs: RATCHET_POLL_INTERVAL_MS });
  }

  /**
   * Stop the ratchet monitor and wait for in-flight checks
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.monitorLoop) {
      logger.debug('Waiting for ratchet monitor loop to complete');
      await this.monitorLoop;
      this.monitorLoop = null;
    }

    logger.info('Ratchet service stopped');
  }

  /**
   * Continuous loop that checks all workspaces, waits for completion, then sleeps
   */
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

  /**
   * Check all active workspaces with PRs for ratchet progression
   */
  async checkAllWorkspaces(): Promise<RatchetCheckResult> {
    if (this.isShuttingDown) {
      return { checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] };
    }

    // Fetch settings once for all workspaces
    const userSettings = await userSettingsAccessor.get();
    const settings: RatchetSettings = {
      autoFixCi: userSettings.ratchetAutoFixCi,
      autoFixConflicts: userSettings.ratchetAutoFixConflicts,
      autoFixReviews: userSettings.ratchetAutoFixReviews,
      autoMerge: userSettings.ratchetAutoMerge,
      allowedReviewers: (userSettings.ratchetAllowedReviewers as string[]) ?? [],
    };

    // Find all READY workspaces with PRs
    const workspaces = await workspaceAccessor.findWithPRsForRatchet();

    if (workspaces.length === 0) {
      return { checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] };
    }

    logger.debug('Checking workspaces for ratchet progression', { count: workspaces.length });

    // Process workspaces concurrently with rate limiting
    const results = await Promise.all(
      workspaces.map((workspace) =>
        this.checkLimit(() => this.processWorkspace(workspace, settings))
      )
    );

    const stateChanges = results.filter((r) => r.previousState !== r.newState).length;
    const actionsTriggered = results.filter(
      (r) => r.action.type === 'TRIGGERED_FIXER' || r.action.type === 'NOTIFIED_ACTIVE_FIXER'
    ).length;

    if (stateChanges > 0 || actionsTriggered > 0) {
      logger.info('Ratchet check completed', {
        checked: workspaces.length,
        stateChanges,
        actionsTriggered,
      });
    }

    return { checked: workspaces.length, stateChanges, actionsTriggered, results };
  }

  /**
   * Check a single workspace immediately (used when ratcheting is toggled on).
   */
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
      autoFixConflicts: userSettings.ratchetAutoFixConflicts,
      autoFixReviews: userSettings.ratchetAutoFixReviews,
      autoMerge: userSettings.ratchetAutoMerge,
      allowedReviewers: (userSettings.ratchetAllowedReviewers as string[]) ?? [],
    };

    return this.processWorkspace(workspace, settings);
  }

  /**
   * Process a single workspace through the ratchet state machine
   */
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
      // 1. Fetch current PR state from GitHub (pass allowedReviewers for filtering)
      const prStateInfo = await this.fetchPRState(workspace, settings.allowedReviewers);
      if (!prStateInfo) {
        return {
          workspaceId: workspace.id,
          previousState: workspace.ratchetState,
          newState: workspace.ratchetState,
          action: { type: 'ERROR', error: 'Failed to fetch PR state' },
        };
      }

      // 2. Determine ratchet state
      const newState = this.determineRatchetState(prStateInfo);
      const previousState = workspace.ratchetState;

      // 3. Log state transition if changed
      if (newState !== previousState) {
        logger.info('Ratchet state transition', {
          workspaceId: workspace.id,
          from: previousState,
          to: newState,
          prNumber: prStateInfo.prNumber,
        });
      }

      // 4. Check workspace-level ratchet setting using latest value to avoid
      // triggering actions after a user disables ratchet during an in-flight check.
      const latestWorkspace = await workspaceAccessor.findById(workspace.id);
      const shouldTakeAction = latestWorkspace?.ratchetEnabled ?? workspace.ratchetEnabled;

      // 5. Take action based on state (only if ratcheting is enabled for this workspace)
      const action = shouldTakeAction
        ? await this.executeRatchetAction(workspace, newState, prStateInfo, settings)
        : { type: 'DISABLED' as const, reason: 'Workspace ratcheting disabled' };

      // 6. Update workspace (including review check timestamp if we found review comments)
      const now = new Date();
      const shouldRecordCiRunId =
        shouldTakeAction &&
        prStateInfo.ciStatus === CIStatus.FAILURE &&
        !!prStateInfo.ciRunId &&
        (action.type === 'NOTIFIED_ACTIVE_FIXER' ||
          (action.type === 'TRIGGERED_FIXER' && action.promptSent));
      await workspaceAccessor.update(workspace.id, {
        ratchetState: shouldTakeAction ? newState : RatchetState.IDLE,
        ratchetLastCheckedAt: now,
        ...(shouldRecordCiRunId ? { ratchetLastCiRunId: prStateInfo.ciRunId } : {}),
        // Update review timestamp if we detected review comments
        ...(prStateInfo.hasNewReviewComments ? { prReviewLastCheckedAt: now } : {}),
      });

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

  /**
   * Fetch current PR state from GitHub
   */
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

  /**
   * Fetch current PR state from GitHub
   */
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

      // Convert statusCheckRollup to the format expected by computeCIStatus
      const statusCheckRollup =
        prDetails.statusCheckRollup?.map((check) => ({
          status: check.status,
          conclusion: check.conclusion ?? undefined,
        })) ?? null;

      const ciStatus = githubCLIService.computeCIStatus(statusCheckRollup);

      // Extract failed checks for CI failure notifications
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

      // Check for reviews requesting changes
      const hasChangesRequested = prDetails.reviews.some((r) => r.state === 'CHANGES_REQUESTED');

      // Filter comments by allowed reviewers (if configured) and by timestamp (new or edited since last check)
      const lastCheckedAt = workspace.prReviewLastCheckedAt?.getTime() ?? 0;
      const filterByReviewer = allowedReviewers.length > 0;

      // Filter new or edited review comments (line-level code comments)
      const newReviewComments = reviewComments.filter((comment) => {
        const createdTime = new Date(comment.createdAt).getTime();
        const updatedTime = new Date(comment.updatedAt).getTime();
        const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;
        const isAllowedReviewer =
          !filterByReviewer || allowedReviewers.includes(comment.author.login);
        return isNewOrEdited && isAllowedReviewer;
      });

      // Filter new or edited PR comments (regular conversation comments)
      const newPRComments = prDetails.comments.filter((comment) => {
        const createdTime = new Date(comment.createdAt).getTime();
        const updatedTime = new Date(comment.updatedAt).getTime();
        const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;
        const isAllowedReviewer =
          !filterByReviewer || allowedReviewers.includes(comment.author.login);
        return isNewOrEdited && isAllowedReviewer;
      });

      // Check if there are any new comments from allowed reviewers
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

  /**
   * Determine ratchet state from PR state info
   */
  private determineRatchetState(pr: PRStateInfo): RatchetState {
    // Check if PR is merged
    if (pr.prState === 'MERGED') {
      return RatchetState.MERGED;
    }

    // Check if CI is still running
    if (pr.ciStatus === CIStatus.PENDING) {
      return RatchetState.CI_RUNNING;
    }

    // Check if CI failed
    if (pr.ciStatus === CIStatus.FAILURE) {
      return RatchetState.CI_FAILED;
    }

    // UNKNOWN means CI result isn't complete enough to trust as green.
    if (pr.ciStatus === CIStatus.UNKNOWN) {
      return RatchetState.CI_RUNNING;
    }

    // CI is green from here on...

    // Check for merge conflicts
    if (pr.mergeStateStatus === 'CONFLICTING') {
      return RatchetState.MERGE_CONFLICT;
    }

    // Check for unaddressed review comments (either formal changes requested OR new review comments)
    if (pr.hasChangesRequested || pr.hasNewReviewComments) {
      return RatchetState.REVIEW_PENDING;
    }

    // All clear - ready to merge
    return RatchetState.READY;
  }

  /**
   * Execute the appropriate action based on ratchet state
   */
  private async executeRatchetAction(
    workspace: WorkspaceWithPR,
    state: RatchetState,
    prStateInfo: PRStateInfo,
    settings: RatchetSettings
  ): Promise<RatchetAction> {
    const existingFixerResult = await this.handleExistingFixerSession(
      workspace,
      state,
      prStateInfo
    );
    if (existingFixerResult) {
      return existingFixerResult;
    }

    return this.handleStateWithoutActiveFixer(workspace, state, prStateInfo, settings);
  }

  private async handleExistingFixerSession(
    workspace: WorkspaceWithPR,
    state: RatchetState,
    prStateInfo: PRStateInfo
  ): Promise<RatchetAction | null> {
    if (!workspace.ratchetActiveSessionId) {
      return null;
    }

    const session = await claudeSessionAccessor.findById(workspace.ratchetActiveSessionId);
    const client = sessionService.getClient(workspace.ratchetActiveSessionId);
    if (!session) {
      await workspaceAccessor.update(workspace.id, { ratchetActiveSessionId: null });
      return null;
    }

    if (session.status === SessionStatus.IDLE) {
      // Keep linkage so triggerFixer can restart this session instead of creating churn.
      return null;
    }

    if (session.status !== SessionStatus.RUNNING || !client) {
      await workspaceAccessor.update(workspace.id, { ratchetActiveSessionId: null });
      return null;
    }

    const shouldNotify = this.shouldNotifyActiveFixer(
      state,
      workspace.ratchetLastNotifiedState,
      prStateInfo.ciRunId,
      workspace.ratchetLastCiRunId
    );

    if (!shouldNotify) {
      return { type: 'FIXER_ACTIVE', sessionId: workspace.ratchetActiveSessionId };
    }

    const delivered = await this.notifyActiveFixer(workspace, state, prStateInfo, client);
    if (delivered) {
      return {
        type: 'NOTIFIED_ACTIVE_FIXER',
        sessionId: workspace.ratchetActiveSessionId,
        issue: state,
      };
    }

    logger.warn('Failed to notify active fixer; clearing stale reference and retrying', {
      workspaceId: workspace.id,
      sessionId: workspace.ratchetActiveSessionId,
      state,
    });
    await workspaceAccessor.update(workspace.id, { ratchetActiveSessionId: null });

    return null;
  }

  private async handleStateWithoutActiveFixer(
    workspace: WorkspaceWithPR,
    state: RatchetState,
    prStateInfo: PRStateInfo,
    settings: RatchetSettings
  ): Promise<RatchetAction> {
    switch (state) {
      case RatchetState.IDLE:
        return { type: 'WAITING', reason: 'No PR or ratchet not active' };

      case RatchetState.CI_RUNNING:
        return { type: 'WAITING', reason: 'CI is running' };

      case RatchetState.CI_FAILED:
        if (!settings.autoFixCi) {
          return { type: 'DISABLED', reason: 'CI auto-fix disabled' };
        }
        return await this.triggerFixer(workspace, 'ci', prStateInfo, settings);

      case RatchetState.MERGE_CONFLICT:
        if (!settings.autoFixConflicts) {
          return { type: 'DISABLED', reason: 'Conflict resolution disabled' };
        }
        return await this.triggerFixer(workspace, 'merge', prStateInfo, settings);

      case RatchetState.REVIEW_PENDING:
        if (!settings.autoFixReviews) {
          return { type: 'DISABLED', reason: 'Review auto-fix disabled' };
        }
        return await this.triggerFixer(workspace, 'review', prStateInfo, settings);

      case RatchetState.READY:
        if (settings.autoMerge) {
          // TODO: Implement auto-merge
          logger.info('PR ready for merge (auto-merge not yet implemented)', {
            workspaceId: workspace.id,
            prNumber: workspace.prNumber,
          });
          return { type: 'READY_FOR_MERGE' };
        }
        return { type: 'READY_FOR_MERGE' };

      case RatchetState.MERGED:
        return { type: 'COMPLETED' };

      default:
        return { type: 'WAITING', reason: `Unknown state: ${state}` };
    }
  }

  /**
   * Check if we should notify the active fixer about a state change
   */
  private shouldNotifyActiveFixer(
    currentState: RatchetState,
    lastNotifiedState: RatchetState | null,
    currentCiRunId: string | null,
    lastCiRunId: string | null
  ): boolean {
    if (
      currentState === RatchetState.CI_FAILED &&
      currentCiRunId &&
      currentCiRunId !== lastCiRunId
    ) {
      return true;
    }

    // Don't notify if state hasn't changed since last notification
    if (currentState === lastNotifiedState) {
      return false;
    }

    // Priority states that should always trigger notification
    const priorityStates: RatchetState[] = [RatchetState.CI_FAILED, RatchetState.MERGE_CONFLICT];
    return priorityStates.includes(currentState);
  }

  /**
   * Notify the active fixer session about a state change
   */
  private async notifyActiveFixer(
    workspace: WorkspaceWithPR,
    state: RatchetState,
    prStateInfo: PRStateInfo,
    client: NonNullable<ReturnType<typeof sessionService.getClient>>
  ): Promise<boolean> {
    if (!workspace.ratchetActiveSessionId) {
      logger.warn('notifyActiveFixer called without active session ID', {
        workspaceId: workspace.id,
      });
      return false;
    }

    let message = '';

    if (state === RatchetState.CI_FAILED) {
      message = `⚠️ **CI Failed**

The CI checks have failed. This may be due to your recent changes.

**Failed checks:**
${prStateInfo.failedChecks.map((c) => `- **${c.name}**: ${c.conclusion}${c.detailsUrl ? ` ([logs](${c.detailsUrl}))` : ''}`).join('\n')}

Please investigate and fix the CI failure before continuing with your current task.
Use \`gh pr checks ${prStateInfo.prNumber}\` to see current status.
Use \`gh run view <run-id> --log-failed\` to see detailed logs.`;
    } else if (state === RatchetState.MERGE_CONFLICT) {
      message = `⚠️ **Merge Conflict Detected**

The branch now has merge conflicts with the base branch.
Please resolve the conflicts before continuing.

Run \`git fetch origin && git merge origin/main\` to see the conflicts.`;
    }

    if (message) {
      try {
        await client.sendMessage(message);
        logger.info('Notified active fixer about state change', {
          workspaceId: workspace.id,
          sessionId: workspace.ratchetActiveSessionId,
          state,
        });

        // Only update last notified state after confirmed delivery
        await workspaceAccessor.update(workspace.id, {
          ratchetLastNotifiedState: state,
        });
        return true;
      } catch (error) {
        logger.warn('Failed to notify fixer about state change', {
          workspaceId: workspace.id,
          state,
          error,
        });
        return false;
      }
    }
    return false;
  }

  /**
   * Trigger a fixer session for the given type
   */
  private async triggerFixer(
    workspace: WorkspaceWithPR,
    fixerType: 'ci' | 'merge' | 'review',
    prStateInfo: PRStateInfo,
    settings: RatchetSettings
  ): Promise<RatchetAction> {
    try {
      const result = await fixerSessionService.acquireAndDispatch({
        workspaceId: workspace.id,
        workflow: RATCHET_WORKFLOW,
        sessionName: 'Ratchet',
        runningIdleAction: 'restart',
        dispatchMode: 'start_empty_and_send',
        buildPrompt: () =>
          this.buildInitialPrompt(fixerType, workspace.prUrl, prStateInfo, settings),
        beforeStart: ({ sessionId, prompt }) => {
          messageStateService.injectCommittedUserMessage(sessionId, prompt);
        },
      });

      if (result.status === 'started') {
        const shouldMarkNotified = result.promptSent ?? true;
        await workspaceAccessor.update(workspace.id, {
          ratchetActiveSessionId: result.sessionId,
          ...(shouldMarkNotified && {
            ratchetLastNotifiedState: this.determineRatchetState(prStateInfo),
          }),
        });

        logger.info('Ratchet fixer session started', {
          workspaceId: workspace.id,
          sessionId: result.sessionId,
          fixerType,
          prNumber: prStateInfo.prNumber,
        });

        return {
          type: 'TRIGGERED_FIXER',
          sessionId: result.sessionId,
          fixerType,
          promptSent: shouldMarkNotified,
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
        fixerType,
      });
      return { type: 'ERROR', error: errorMessage };
    }
  }

  /**
   * Build the initial prompt for a fixer session
   */
  private buildInitialPrompt(
    fixerType: 'ci' | 'merge' | 'review',
    prUrl: string,
    prStateInfo: PRStateInfo,
    settings: RatchetSettings
  ): string {
    const prNumber = prStateInfo.prNumber;

    switch (fixerType) {
      case 'ci':
        return this.buildCIFixPrompt(prNumber, prUrl, prStateInfo);
      case 'merge':
        return this.buildMergeFixPrompt(prNumber, prUrl);
      case 'review':
        return this.buildReviewFixPrompt(prNumber, prUrl, prStateInfo, settings);
      default:
        return `Please investigate the issue with PR #${prNumber}.`;
    }
  }

  private buildCIFixPrompt(prNumber: number, prUrl: string, prStateInfo: PRStateInfo): string {
    let prompt = `## CI Failure Alert

The CI checks for PR #${prNumber} have failed.

**PR URL:** ${prUrl}

`;

    if (prStateInfo.failedChecks.length > 0) {
      prompt += `### Failed Checks\n\n`;
      for (const check of prStateInfo.failedChecks) {
        prompt += `- **${check.name}**: ${check.conclusion}`;
        if (check.detailsUrl) {
          prompt += ` ([logs](${check.detailsUrl}))`;
        }
        prompt += `\n`;
      }
      prompt += `\n`;
    }

    prompt += `### Next Steps

1. Use \`gh pr checks ${prNumber}\` to see the current check status
2. Use \`gh run view <run-id> --log-failed\` to see detailed failure logs
3. Identify the root cause and implement a fix
4. Run tests locally to verify: \`pnpm test\`
5. Run type checking: \`pnpm typecheck\`
6. Run linting: \`pnpm check:fix\`
7. Commit and push your changes

Please investigate and fix these CI failures.`;

    return prompt;
  }

  private buildMergeFixPrompt(prNumber: number, prUrl: string): string {
    return `## Merge Conflict Alert

PR #${prNumber} has merge conflicts with the base branch.

**PR URL:** ${prUrl}

### Next Steps

1. Fetch the latest changes: \`git fetch origin\`
2. Merge the base branch: \`git merge origin/main\`
3. Resolve any conflicts in the affected files
4. For each conflict:
   - Understand both sides of the change
   - Preserve functionality from both when possible
   - If unsure, prefer the main branch changes
5. After resolving, run tests: \`pnpm test\`
6. Run type checking: \`pnpm typecheck\`
7. Commit the merge: \`git commit -m "Merge main into feature branch"\`
8. Push your changes: \`git push\`

Please resolve these merge conflicts.`;
  }

  /**
   * Filter items by allowed reviewers if configured
   */
  private filterByAllowedReviewers<T extends { author: { login: string } }>(
    items: T[],
    allowedReviewers: string[]
  ): T[] {
    if (allowedReviewers.length === 0) {
      return items;
    }
    return items.filter((item) => allowedReviewers.includes(item.author.login));
  }

  /**
   * Format reviews requesting changes for the prompt
   */
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

  /**
   * Format line-level code comments for the prompt
   */
  private formatCodeCommentsSection(comments: PRStateInfo['reviewComments']): string {
    if (comments.length === 0) {
      return '';
    }

    const lines = ['### Review Comments on Code\n\n'];
    for (const comment of comments) {
      const location = comment.line ? `:${comment.line}` : '';
      lines.push(`**${comment.author.login}** on \`${comment.path}\`${location}:\n`);
      lines.push(`> ${comment.body.split('\n').join('\n> ')}\n`);
      lines.push(`> [View comment](${comment.url})\n\n`);
    }
    return lines.join('');
  }

  /**
   * Format regular PR comments for the prompt
   */
  private formatPRCommentsSection(comments: PRStateInfo['comments']): string {
    if (comments.length === 0) {
      return '';
    }

    const lines = ['### PR Comments\n\n'];
    for (const comment of comments) {
      lines.push(
        `**${comment.author.login}** (${new Date(comment.createdAt).toLocaleDateString()}):\n`
      );
      lines.push(`> ${comment.body.split('\n').join('\n> ')}\n\n`);
    }
    return lines.join('');
  }

  private buildReviewFixPrompt(
    prNumber: number,
    prUrl: string,
    prStateInfo: PRStateInfo,
    settings: RatchetSettings
  ): string {
    const parts: string[] = [
      `## PR Review Comments Alert

New review comments have been received on PR #${prNumber}.

**PR URL:** ${prUrl}

`,
    ];

    // Filter and format reviews requesting changes (by allowed reviewers)
    const changesRequestedReviews = prStateInfo.reviews.filter(
      (r) => r.state === 'CHANGES_REQUESTED'
    );
    const filteredReviews = this.filterByAllowedReviewers(
      changesRequestedReviews,
      settings.allowedReviewers
    );
    parts.push(this.formatReviewsSection(filteredReviews));

    // Format NEW line-level code comments (already filtered by timestamp and allowed reviewers)
    parts.push(this.formatCodeCommentsSection(prStateInfo.newReviewComments));

    // Format NEW regular PR comments (already filtered by timestamp and allowed reviewers)
    parts.push(this.formatPRCommentsSection(prStateInfo.newPRComments));

    // Get reviewer usernames for re-review request
    const reviewerSet = new Set([
      ...filteredReviews.map((r) => r.author.login),
      ...prStateInfo.newReviewComments.map((c) => c.author.login),
      ...prStateInfo.newPRComments.map((c) => c.author.login),
    ]);
    const reviewerMentions = Array.from(reviewerSet)
      .map((r) => `@${r}`)
      .join(' ');

    parts.push(`### Instructions

**IMPORTANT: Execute autonomously. Do not ask the user for input or confirmation. Complete all steps without waiting.**

1. **Analyze each comment** - Determine what changes are requested. If a comment is purely informational (e.g., automated coverage reports with no action items), note it and move on.

2. **Implement fixes** - Address each actionable comment systematically. Make focused changes that directly address the feedback.

3. **Verify changes**:
   \`\`\`bash
   pnpm test && pnpm typecheck && pnpm check:fix
   \`\`\`

4. **Commit and push**:
   \`\`\`bash
   git add -A && git commit -m "Address review comments" && git push
   \`\`\`

5. **Post re-review request** - After pushing, notify the reviewers:
   \`\`\`bash
   gh pr comment ${prNumber} --body "${reviewerMentions} I've addressed the review comments. Please re-review when you have a chance."
   \`\`\`

**Do not ask the user what to do. Analyze the comments, implement fixes, push, and request re-review.**`);

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
