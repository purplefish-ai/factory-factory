/**
 * CI Fixer Service
 *
 * Creates and manages dedicated Claude sessions to fix CI failures.
 * Prevents duplicate concurrent CI fixing sessions per workspace.
 */

import type { SessionStatus } from '@prisma-gen/client';
import { fixerSessionService } from './fixer-session.service';
import { createLogger } from './logger.service';
import { sessionService } from './session.service';

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

  async triggerCIFix(params: {
    workspaceId: string;
    prUrl: string;
    prNumber: number;
    failureDetails?: CIFailureDetails;
  }): Promise<CIFixResult> {
    const { workspaceId } = params;

    const pending = this.pendingFixes.get(workspaceId);
    if (pending) {
      logger.debug('CI fix operation already in progress', { workspaceId });
      return pending;
    }

    const promise = this.doTriggerCIFix(params);
    this.pendingFixes.set(workspaceId, promise);

    try {
      return await promise;
    } finally {
      this.pendingFixes.delete(workspaceId);
    }
  }

  private async doTriggerCIFix(params: {
    workspaceId: string;
    prUrl: string;
    prNumber: number;
    failureDetails?: CIFailureDetails;
  }): Promise<CIFixResult> {
    const { workspaceId, prUrl, prNumber, failureDetails } = params;

    try {
      const result = await fixerSessionService.acquireAndDispatch({
        workspaceId,
        workflow: CI_FIX_WORKFLOW,
        sessionName: 'CI Fixing',
        runningIdleAction: 'send_message',
        buildPrompt: () => this.buildInitialPrompt(prUrl, prNumber, failureDetails),
      });

      if (result.status === 'started') {
        logger.info('CI fixing session started', {
          workspaceId,
          sessionId: result.sessionId,
          prNumber,
        });
        return { status: 'started', sessionId: result.sessionId };
      }

      if (result.status === 'already_active') {
        return { status: 'already_fixing', sessionId: result.sessionId };
      }

      if (result.status === 'skipped') {
        return { status: 'skipped', reason: result.reason };
      }

      return { status: 'error', error: result.error };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to trigger CI fix', error as Error, { workspaceId, prUrl });
      return { status: 'error', error: errorMessage };
    }
  }

  async isFixingInProgress(workspaceId: string): Promise<boolean> {
    const session = await this.getActiveCIFixSession(workspaceId);
    if (!session) {
      return false;
    }
    return sessionService.isSessionWorking(session.id);
  }

  async getActiveCIFixSession(
    workspaceId: string
  ): Promise<{ id: string; status: SessionStatus } | null> {
    return await fixerSessionService.getActiveSession(workspaceId, CI_FIX_WORKFLOW);
  }

  async notifyCIPassed(workspaceId: string): Promise<boolean> {
    const session = await this.getActiveCIFixSession(workspaceId);
    if (!session) {
      return false;
    }

    const client = sessionService.getClient(session.id);
    if (!client?.isRunning()) {
      return false;
    }

    client
      .sendMessage(
        '✅ **CI Passed** - The CI checks are now passing. You can wrap up your current work.'
      )
      .catch((error) => {
        logger.warn('Failed to notify CI fixer session', { workspaceId, error });
      });

    logger.info('Notified CI fixing session that CI passed', {
      workspaceId,
      sessionId: session.id,
    });

    return true;
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
