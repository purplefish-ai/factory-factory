/**
 * CI Fixer Service
 *
 * Creates and manages dedicated Claude sessions to fix CI failures.
 * Prevents duplicate concurrent CI fixing sessions per workspace.
 */

import { SessionStatus } from '@prisma-gen/client';
import { prisma } from '../db';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { configService } from './config.service';
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
  // Track in-flight fix operations to prevent race conditions
  private readonly pendingFixes = new Map<string, Promise<CIFixResult>>();

  /**
   * Attempt to start a CI fixing session for a workspace.
   * Returns early if a CI fixing session is already active.
   */
  async triggerCIFix(params: {
    workspaceId: string;
    prUrl: string;
    prNumber: number;
    failureDetails?: CIFailureDetails;
  }): Promise<CIFixResult> {
    const { workspaceId } = params;

    // Check for in-flight operation to prevent concurrent triggers
    const pending = this.pendingFixes.get(workspaceId);
    if (pending) {
      logger.debug('CI fix operation already in progress', { workspaceId });
      return pending;
    }

    // Create and track the operation
    const promise = this.doTriggerCIFix(params);
    this.pendingFixes.set(workspaceId, promise);

    try {
      return await promise;
    } finally {
      this.pendingFixes.delete(workspaceId);
    }
  }

  /**
   * Internal: Perform the CI fix operation with database transaction
   */
  private async doTriggerCIFix(params: {
    workspaceId: string;
    prUrl: string;
    prNumber: number;
    failureDetails?: CIFailureDetails;
  }): Promise<CIFixResult> {
    const { workspaceId, prUrl, prNumber, failureDetails } = params;

    try {
      // Validate workspace exists and has a worktree
      const workspace = await workspaceAccessor.findById(workspaceId);
      if (!workspace?.worktreePath) {
        logger.warn('Workspace not ready for CI fix', { workspaceId });
        return { status: 'skipped', reason: 'Workspace not ready (no worktree path)' };
      }

      // Use transaction to prevent race conditions when checking/creating session
      const result = await prisma.$transaction(async (tx) => {
        // Check for existing CI fixing session
        const existingSession = await tx.claudeSession.findFirst({
          where: {
            workspaceId,
            workflow: CI_FIX_WORKFLOW,
            status: { in: [SessionStatus.RUNNING, SessionStatus.IDLE] },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existingSession) {
          // Check if it's actively working
          const isWorking = sessionService.isSessionWorking(existingSession.id);
          if (isWorking) {
            logger.info('CI fixing session already active and working', {
              workspaceId,
              sessionId: existingSession.id,
            });
            return {
              action: 'already_fixing' as const,
              sessionId: existingSession.id,
            };
          }

          // Session exists but is idle - we can send a new message to it
          if (existingSession.status === SessionStatus.RUNNING) {
            logger.info('CI fixing session exists and running, will send new prompt', {
              workspaceId,
              sessionId: existingSession.id,
            });
            return {
              action: 'send_message' as const,
              sessionId: existingSession.id,
            };
          }

          // Session is IDLE - restart it
          logger.info('Restarting idle CI fixing session', {
            workspaceId,
            sessionId: existingSession.id,
          });
          return {
            action: 'restart' as const,
            sessionId: existingSession.id,
          };
        }

        // Check session limit before creating new session
        const allSessions = await tx.claudeSession.findMany({
          where: { workspaceId },
          select: { id: true },
        });
        const maxSessions = configService.getMaxSessionsPerWorkspace();
        if (allSessions.length >= maxSessions) {
          logger.warn('Cannot create CI fix session: workspace session limit reached', {
            workspaceId,
            currentSessions: allSessions.length,
            maxSessions,
          });
          return {
            action: 'limit_reached' as const,
          };
        }

        // Get model from most recent session in workspace
        const recentSession = await tx.claudeSession.findFirst({
          where: { workspaceId, workflow: { not: CI_FIX_WORKFLOW } },
          orderBy: { updatedAt: 'desc' },
          select: { model: true },
        });
        const model = recentSession?.model ?? 'sonnet';

        // Create new CI fixing session
        const newSession = await tx.claudeSession.create({
          data: {
            workspaceId,
            workflow: CI_FIX_WORKFLOW,
            name: 'CI Fixing',
            model,
            status: SessionStatus.IDLE,
          },
        });

        logger.info('Created new CI fixing session', {
          workspaceId,
          sessionId: newSession.id,
          model,
        });

        return {
          action: 'start' as const,
          sessionId: newSession.id,
        };
      });

      // Handle the result outside the transaction
      if (result.action === 'limit_reached') {
        return { status: 'skipped', reason: 'Workspace session limit reached' };
      }

      const initialPrompt = this.buildInitialPrompt(prUrl, prNumber, failureDetails);

      if (result.action === 'already_fixing') {
        return { status: 'already_fixing', sessionId: result.sessionId };
      }

      if (result.action === 'send_message') {
        // Send new message to existing running session
        const client = sessionService.getClient(result.sessionId);
        if (client) {
          client.sendMessage(initialPrompt).catch((error) => {
            logger.warn('Failed to send CI failure notification', {
              workspaceId,
              sessionId: result.sessionId,
              error,
            });
          });
          logger.info('Sent CI failure notification to existing session', {
            workspaceId,
            sessionId: result.sessionId,
          });
        }
        return { status: 'already_fixing', sessionId: result.sessionId };
      }

      // Start or restart the session
      await sessionService.startClaudeSession(result.sessionId, {
        initialPrompt,
      });

      logger.info('CI fixing session started', {
        workspaceId,
        sessionId: result.sessionId,
        prNumber,
      });

      return { status: 'started', sessionId: result.sessionId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to trigger CI fix', error as Error, { workspaceId, prUrl });
      return { status: 'error', error: errorMessage };
    }
  }

  /**
   * Check if a CI fixing session is currently active for a workspace.
   */
  async isFixingInProgress(workspaceId: string): Promise<boolean> {
    const session = await this.getActiveCIFixSession(workspaceId);
    if (!session) {
      return false;
    }
    return sessionService.isSessionWorking(session.id);
  }

  /**
   * Get the active CI fixing session for a workspace, if any.
   */
  async getActiveCIFixSession(
    workspaceId: string
  ): Promise<{ id: string; status: SessionStatus } | null> {
    const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId);
    const ciFixSession = sessions.find(
      (s) =>
        s.workflow === CI_FIX_WORKFLOW &&
        (s.status === SessionStatus.RUNNING || s.status === SessionStatus.IDLE)
    );
    return ciFixSession ? { id: ciFixSession.id, status: ciFixSession.status } : null;
  }

  /**
   * Notify an active CI fixing session that CI has passed.
   */
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

  /**
   * Build the initial prompt for a CI fixing session.
   */
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
