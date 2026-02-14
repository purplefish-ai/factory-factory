/**
 * CI Fixer Service
 *
 * Creates and manages dedicated Claude sessions to fix CI failures.
 * Prevents duplicate concurrent CI fixing sessions per workspace.
 */

import {
  dispatchFixWorkflow,
  isFixWorkflowInProgress,
  notifyFixWorkflowSession,
  runExclusiveWorkspaceOperation,
} from '@/backend/services/fixer-workflow.service';
import { createLogger } from '@/backend/services/logger.service';
import type { SessionStatus } from '@/shared/core';
import type { RatchetSessionBridge } from './bridges';
import { fixerSessionService } from './fixer-session.service';

const logger = createLogger('ci-fixer');

const CI_FIX_WORKFLOW = 'ci-fix';

export interface CIFailureDetails {
  failedChecks: Array<{
    name: string;
    conclusion: string;
    detailsUrl?: string;
  }>;
  checkRunsUrl?: string;
}

export type CIFixResult =
  | { status: 'started'; sessionId: string }
  | { status: 'already_fixing'; sessionId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

class CIFixerService {
  private readonly pendingFixes = new Map<string, Promise<CIFixResult>>();
  private sessionBridge: RatchetSessionBridge | null = null;

  configure(bridges: { session: RatchetSessionBridge }): void {
    this.sessionBridge = bridges.session;
  }

  private get session(): RatchetSessionBridge {
    if (!this.sessionBridge) {
      throw new Error(
        'CIFixerService not configured: session bridge missing. Call configure() first.'
      );
    }
    return this.sessionBridge;
  }

  triggerCIFix(params: {
    workspaceId: string;
    prUrl: string;
    prNumber: number;
    failureDetails?: CIFailureDetails;
  }): Promise<CIFixResult> {
    const { workspaceId, prUrl, prNumber, failureDetails } = params;

    return runExclusiveWorkspaceOperation({
      pendingMap: this.pendingFixes,
      workspaceId,
      logger,
      duplicateOperationMessage: 'CI fix operation already in progress',
      operation: () =>
        dispatchFixWorkflow({
          workspaceId,
          workflow: CI_FIX_WORKFLOW,
          sessionName: 'CI Fixing',
          runningIdleAction: 'send_message',
          acquireAndDispatch: fixerSessionService.acquireAndDispatch.bind(fixerSessionService),
          buildPrompt: () => this.buildInitialPrompt(prUrl, prNumber, failureDetails),
          logger,
          startedLogMessage: 'CI fixing session started',
          failureLogMessage: 'Failed to trigger CI fix',
          startedLogMeta: { prNumber },
          errorLogMeta: { prUrl },
        }),
    });
  }

  isFixingInProgress(workspaceId: string): Promise<boolean> {
    return isFixWorkflowInProgress({
      workspaceId,
      workflow: CI_FIX_WORKFLOW,
      getActiveSession: (targetWorkspaceId, workflow) =>
        fixerSessionService.getActiveSession(targetWorkspaceId, workflow),
      isSessionWorking: (sessionId) => this.session.isSessionWorking(sessionId),
    });
  }

  async getActiveCIFixSession(
    workspaceId: string
  ): Promise<{ id: string; status: SessionStatus } | null> {
    return await fixerSessionService.getActiveSession(workspaceId, CI_FIX_WORKFLOW);
  }

  notifyCIPassed(workspaceId: string): Promise<boolean> {
    return notifyFixWorkflowSession({
      workspaceId,
      workflow: CI_FIX_WORKFLOW,
      getActiveSession: (targetWorkspaceId, workflow) =>
        fixerSessionService.getActiveSession(targetWorkspaceId, workflow),
      isSessionRunning: (sessionId) => this.session.isSessionRunning(sessionId),
      sendSessionMessage: (sessionId, message) =>
        this.session.sendSessionMessage(sessionId, message),
      message:
        '✅ **CI Passed** - The CI checks are now passing. You can wrap up your current work.',
      logger,
      successLogMessage: 'Notified CI fixing session that CI passed',
      failureLogMessage: 'Failed to notify CI fixer session',
    });
  }

  private buildInitialPrompt(
    prUrl: string,
    prNumber: number,
    failureDetails?: CIFailureDetails
  ): string {
    let prompt = `## CI Failure Alert

The CI checks for PR #${prNumber} have failed.

**PR URL:** ${prUrl}

`;

    if (failureDetails?.failedChecks?.length) {
      prompt += `### Failed Checks\n\n`;
      for (const check of failureDetails.failedChecks) {
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
4. Commit and push your changes

Please investigate and fix these CI failures.`;

    return prompt;
  }
}

export const ciFixerService = new CIFixerService();
