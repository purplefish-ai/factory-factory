/**
 * PR Review Fixer Service
 *
 * Creates and manages dedicated Claude sessions to address PR review comments.
 * Prevents duplicate concurrent review-fixing sessions per workspace.
 */

import { SessionStatus } from '@prisma-gen/client';
import { prisma } from '../db';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { configService } from './config.service';
import { createLogger } from './logger.service';
import { sessionService } from './session.service';

const logger = createLogger('pr-review-fixer');

const PR_REVIEW_FIX_WORKFLOW = 'pr-review-fix';

export interface ReviewCommentDetails {
  reviews: Array<{
    id: string;
    author: string;
    state: string;
    body: string;
    submittedAt: string;
  }>;
  comments: Array<{
    id: number;
    author: string;
    body: string;
    createdAt: string;
    url: string;
    path?: string;
    line?: number | null;
  }>;
}

export type PRReviewFixResult =
  | { status: 'started'; sessionId: string }
  | { status: 'already_fixing'; sessionId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

class PRReviewFixerService {
  // Track in-flight fix operations to prevent race conditions
  private readonly pendingFixes = new Map<string, Promise<PRReviewFixResult>>();

  /**
   * Attempt to start a PR review fixing session for a workspace.
   * Returns early if a review fixing session is already active.
   */
  async triggerReviewFix(params: {
    workspaceId: string;
    prUrl: string;
    prNumber: number;
    commentDetails: ReviewCommentDetails;
    customPrompt?: string;
  }): Promise<PRReviewFixResult> {
    const { workspaceId } = params;

    // Check for in-flight operation to prevent concurrent triggers
    const pending = this.pendingFixes.get(workspaceId);
    if (pending) {
      logger.debug('PR review fix operation already in progress', { workspaceId });
      return pending;
    }

    // Create and track the operation
    const promise = this.doTriggerReviewFix(params);
    this.pendingFixes.set(workspaceId, promise);

    try {
      return await promise;
    } finally {
      this.pendingFixes.delete(workspaceId);
    }
  }

  /**
   * Internal: Perform the review fix operation with database transaction
   */
  private async doTriggerReviewFix(params: {
    workspaceId: string;
    prUrl: string;
    prNumber: number;
    commentDetails: ReviewCommentDetails;
    customPrompt?: string;
  }): Promise<PRReviewFixResult> {
    const { workspaceId, prUrl, prNumber, commentDetails, customPrompt } = params;

    try {
      // Validate workspace exists and has a worktree
      const workspace = await workspaceAccessor.findById(workspaceId);
      if (!workspace?.worktreePath) {
        logger.warn('Workspace not ready for PR review fix', { workspaceId });
        return { status: 'skipped', reason: 'Workspace not ready (no worktree path)' };
      }

      // Use transaction to prevent race conditions when checking/creating session
      const result = await prisma.$transaction(async (tx) => {
        // Check for existing PR review fixing session
        const existingSession = await tx.claudeSession.findFirst({
          where: {
            workspaceId,
            workflow: PR_REVIEW_FIX_WORKFLOW,
            status: { in: [SessionStatus.RUNNING, SessionStatus.IDLE] },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existingSession) {
          // Check if it's actively working
          const isWorking = sessionService.isSessionWorking(existingSession.id);
          if (isWorking) {
            logger.info('PR review fixing session already active and working', {
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
            logger.info('PR review fixing session exists and running, will send new prompt', {
              workspaceId,
              sessionId: existingSession.id,
            });
            return {
              action: 'send_message' as const,
              sessionId: existingSession.id,
            };
          }

          // Session is IDLE - restart it
          logger.info('Restarting idle PR review fixing session', {
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
          logger.warn('Cannot create PR review fix session: workspace session limit reached', {
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
          where: { workspaceId, workflow: { not: PR_REVIEW_FIX_WORKFLOW } },
          orderBy: { updatedAt: 'desc' },
          select: { model: true },
        });
        const model = recentSession?.model ?? 'sonnet';

        // Create new PR review fixing session
        const newSession = await tx.claudeSession.create({
          data: {
            workspaceId,
            workflow: PR_REVIEW_FIX_WORKFLOW,
            name: 'PR Review Fixing',
            model,
            status: SessionStatus.IDLE,
          },
        });

        logger.info('Created new PR review fixing session', {
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

      const initialPrompt = this.buildInitialPrompt(prUrl, prNumber, commentDetails, customPrompt);

      if (result.action === 'already_fixing') {
        return { status: 'already_fixing', sessionId: result.sessionId };
      }

      if (result.action === 'send_message') {
        // Send new message to existing running session
        const client = sessionService.getClient(result.sessionId);
        if (client) {
          client.sendMessage(initialPrompt).catch((error) => {
            logger.warn('Failed to send PR review notification', {
              workspaceId,
              sessionId: result.sessionId,
              error,
            });
          });
          logger.info('Sent PR review comment notification to existing session', {
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

      logger.info('PR review fixing session started', {
        workspaceId,
        sessionId: result.sessionId,
        prNumber,
      });

      return { status: 'started', sessionId: result.sessionId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to trigger PR review fix', error as Error, { workspaceId, prUrl });
      return { status: 'error', error: errorMessage };
    }
  }

  /**
   * Check if a PR review fixing session is currently active for a workspace.
   */
  async isFixingInProgress(workspaceId: string): Promise<boolean> {
    const session = await this.getActiveReviewFixSession(workspaceId);
    if (!session) {
      return false;
    }
    return sessionService.isSessionWorking(session.id);
  }

  /**
   * Get the active PR review fixing session for a workspace, if any.
   */
  async getActiveReviewFixSession(
    workspaceId: string
  ): Promise<{ id: string; status: SessionStatus } | null> {
    const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId);
    const reviewFixSession = sessions.find(
      (s) =>
        s.workflow === PR_REVIEW_FIX_WORKFLOW &&
        (s.status === SessionStatus.RUNNING || s.status === SessionStatus.IDLE)
    );
    return reviewFixSession ? { id: reviewFixSession.id, status: reviewFixSession.status } : null;
  }

  /**
   * Notify an active PR review fixing session that reviews have been addressed.
   */
  async notifyReviewsAddressed(workspaceId: string): Promise<boolean> {
    const session = await this.getActiveReviewFixSession(workspaceId);
    if (!session) {
      return false;
    }

    const client = sessionService.getClient(session.id);
    if (!client?.isRunning()) {
      return false;
    }

    client
      .sendMessage(
        '✅ **Reviews Addressed** - The review comments have been addressed. You can wrap up your current work.'
      )
      .catch((error) => {
        logger.warn('Failed to notify PR review session', { workspaceId, error });
      });

    logger.info('Notified PR review fixing session that reviews were addressed', {
      workspaceId,
      sessionId: session.id,
    });

    return true;
  }

  /**
   * Format a single review for the prompt.
   */
  private formatReview(review: ReviewCommentDetails['reviews'][0]): string {
    let text = `**${review.author}** (${new Date(review.submittedAt).toLocaleDateString()}):\n`;
    if (review.body) {
      text += `> ${review.body.split('\n').join('\n> ')}\n`;
    }
    text += '\n';
    return text;
  }

  /**
   * Format a single comment for the prompt.
   */
  private formatComment(comment: ReviewCommentDetails['comments'][0]): string {
    let text = `**${comment.author}**`;
    if (comment.path) {
      text += ` on \`${comment.path}\``;
      if (comment.line) {
        text += `:${comment.line}`;
      }
    }
    text += ':\n';
    text += `> ${comment.body.split('\n').join('\n> ')}\n`;
    text += `[View comment](${comment.url})\n\n`;
    return text;
  }

  /**
   * Get unique reviewer usernames from comment details.
   */
  private getReviewerUsernames(commentDetails: ReviewCommentDetails): string[] {
    const reviewers = new Set<string>();

    // Add authors from reviews requesting changes
    for (const review of commentDetails.reviews) {
      if (review.state === 'CHANGES_REQUESTED') {
        reviewers.add(review.author);
      }
    }

    // Add authors from comments
    for (const comment of commentDetails.comments) {
      reviewers.add(comment.author);
    }

    return Array.from(reviewers);
  }

  /**
   * Build the initial prompt for a PR review fixing session.
   */
  private buildInitialPrompt(
    prUrl: string,
    prNumber: number,
    commentDetails: ReviewCommentDetails,
    customPrompt?: string
  ): string {
    const parts: string[] = [
      `## PR Review Comments Alert\n\nNew review comments have been received on PR #${prNumber}.\n\n**PR URL:** ${prUrl}\n\n`,
    ];

    // Add reviews that request changes
    const changesRequestedReviews = commentDetails.reviews.filter(
      (r) => r.state === 'CHANGES_REQUESTED'
    );
    if (changesRequestedReviews.length > 0) {
      parts.push('### Reviews Requesting Changes\n\n');
      parts.push(...changesRequestedReviews.map((r) => this.formatReview(r)));
    }

    // Add individual comments
    if (commentDetails.comments.length > 0) {
      parts.push('### Review Comments\n\n');
      parts.push(...commentDetails.comments.map((c) => this.formatComment(c)));
    }

    // Add custom prompt if provided
    if (customPrompt) {
      parts.push(`### Additional Instructions\n\n${customPrompt}\n\n`);
    }

    // Get reviewer usernames for the re-review request
    const reviewers = this.getReviewerUsernames(commentDetails);
    const reviewerMentions = reviewers.map((r) => `@${r}`).join(' ');

    parts.push(`### Next Steps

1. Review the comments above carefully
2. Understand what changes the reviewer is requesting
3. Implement the necessary changes to address the feedback
4. Run tests to ensure your changes don't break anything
5. Commit and push your changes
6. After pushing, post a comment on the PR asking for re-review using this command:
   \`\`\`bash
   gh pr comment ${prNumber} --body "${reviewerMentions} I've addressed the review comments. Please re-review when you have a chance."
   \`\`\`

Please address these review comments.`);

    return parts.join('');
  }
}

export const prReviewFixerService = new PRReviewFixerService();
