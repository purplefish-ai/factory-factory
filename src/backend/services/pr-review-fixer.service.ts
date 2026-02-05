/**
 * PR Review Fixer Service
 *
 * Creates and manages dedicated Claude sessions to address PR review comments.
 * Prevents duplicate concurrent review-fixing sessions per workspace.
 */

import type { SessionStatus } from '@prisma-gen/client';
import { fixerSessionService } from './fixer-session.service';
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
  private readonly pendingFixes = new Map<string, Promise<PRReviewFixResult>>();

  async triggerReviewFix(params: {
    workspaceId: string;
    prUrl: string;
    prNumber: number;
    commentDetails: ReviewCommentDetails;
    customPrompt?: string;
  }): Promise<PRReviewFixResult> {
    const { workspaceId } = params;

    const pending = this.pendingFixes.get(workspaceId);
    if (pending) {
      logger.debug('PR review fix operation already in progress', { workspaceId });
      return pending;
    }

    const promise = this.doTriggerReviewFix(params);
    this.pendingFixes.set(workspaceId, promise);

    try {
      return await promise;
    } finally {
      this.pendingFixes.delete(workspaceId);
    }
  }

  private async doTriggerReviewFix(params: {
    workspaceId: string;
    prUrl: string;
    prNumber: number;
    commentDetails: ReviewCommentDetails;
    customPrompt?: string;
  }): Promise<PRReviewFixResult> {
    const { workspaceId, prUrl, prNumber, commentDetails, customPrompt } = params;

    try {
      const result = await fixerSessionService.acquireAndDispatch({
        workspaceId,
        workflow: PR_REVIEW_FIX_WORKFLOW,
        sessionName: 'PR Review Fixing',
        runningIdleAction: 'send_message',
        buildPrompt: () => this.buildInitialPrompt(prUrl, prNumber, commentDetails, customPrompt),
      });

      if (result.status === 'started') {
        logger.info('PR review fixing session started', {
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
      logger.error('Failed to trigger PR review fix', error as Error, { workspaceId, prUrl });
      return { status: 'error', error: errorMessage };
    }
  }

  async isFixingInProgress(workspaceId: string): Promise<boolean> {
    const session = await this.getActiveReviewFixSession(workspaceId);
    if (!session) {
      return false;
    }
    return sessionService.isSessionWorking(session.id);
  }

  async getActiveReviewFixSession(
    workspaceId: string
  ): Promise<{ id: string; status: SessionStatus } | null> {
    return await fixerSessionService.getActiveSession(workspaceId, PR_REVIEW_FIX_WORKFLOW);
  }

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

  private formatReview(review: ReviewCommentDetails['reviews'][0]): string {
    let text = `**${review.author}** (${new Date(review.submittedAt).toLocaleDateString()}):\n`;
    if (review.body) {
      text += `> ${review.body.split('\n').join('\n> ')}\n`;
    }
    text += '\n';
    return text;
  }

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

  private getReviewerUsernames(commentDetails: ReviewCommentDetails): string[] {
    const reviewers = new Set<string>();

    for (const review of commentDetails.reviews) {
      if (review.state === 'CHANGES_REQUESTED') {
        reviewers.add(review.author);
      }
    }

    for (const comment of commentDetails.comments) {
      reviewers.add(comment.author);
    }

    return Array.from(reviewers);
  }

  private buildInitialPrompt(
    prUrl: string,
    prNumber: number,
    commentDetails: ReviewCommentDetails,
    customPrompt?: string
  ): string {
    const parts: string[] = [
      `## PR Review Comments Alert\n\nNew review comments have been received on PR #${prNumber}.\n\n**PR URL:** ${prUrl}\n\n`,
    ];

    const changesRequestedReviews = commentDetails.reviews.filter(
      (r) => r.state === 'CHANGES_REQUESTED'
    );

    if (changesRequestedReviews.length > 0) {
      parts.push('### Changes Requested Reviews\n\n');
      for (const review of changesRequestedReviews) {
        parts.push(this.formatReview(review));
      }
    }

    if (commentDetails.comments.length > 0) {
      parts.push('### Review Comments\n\n');
      for (const comment of commentDetails.comments) {
        parts.push(this.formatComment(comment));
      }
    }

    if (customPrompt) {
      parts.push('### Additional Instructions\n\n');
      parts.push(`${customPrompt}\n\n`);
    }

    const reviewers = this.getReviewerUsernames(commentDetails);
    const reviewerMentions = reviewers.map((u) => `@${u}`).join(' ');

    parts.push(`### Next Steps

1. Review all comments and requested changes above
2. Implement code changes to address each comment
3. Run tests and ensure CI passes
4. Commit and push your changes
5. Reply to reviewers on GitHub when done (example):
   gh pr comment ${prNumber} --body "${reviewerMentions} I've addressed the review comments. Please re-review when you have a chance."

Please address these review comments thoroughly.`);

    return parts.join('');
  }
}

export const prReviewFixerService = new PRReviewFixerService();
