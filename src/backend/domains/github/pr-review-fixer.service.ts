/**
 * PR Review Fixer Service
 *
 * Creates and manages dedicated Claude sessions to address PR review comments.
 * Prevents duplicate concurrent review-fixing sessions per workspace.
 */

import {
  dispatchFixWorkflow,
  isFixWorkflowInProgress,
  notifyFixWorkflowSession,
  runExclusiveWorkspaceOperation,
} from '@/backend/services/fixer-workflow.service';
import { createLogger } from '@/backend/services/logger.service';
import type { GitHubFixerBridge, GitHubSessionBridge } from './bridges';

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
  private sessionBridge: GitHubSessionBridge | null = null;
  private fixerBridge: GitHubFixerBridge | null = null;

  configure(bridges: { session: GitHubSessionBridge; fixer: GitHubFixerBridge }): void {
    this.sessionBridge = bridges.session;
    this.fixerBridge = bridges.fixer;
  }

  private get session(): GitHubSessionBridge {
    if (!this.sessionBridge) {
      throw new Error(
        'PRReviewFixerService not configured: session bridge missing. Call configure() first.'
      );
    }
    return this.sessionBridge;
  }

  private get fixer(): GitHubFixerBridge {
    if (!this.fixerBridge) {
      throw new Error(
        'PRReviewFixerService not configured: fixer bridge missing. Call configure() first.'
      );
    }
    return this.fixerBridge;
  }

  triggerReviewFix(params: {
    workspaceId: string;
    prUrl: string;
    prNumber: number;
    commentDetails: ReviewCommentDetails;
    customPrompt?: string;
  }): Promise<PRReviewFixResult> {
    const { workspaceId, prUrl, prNumber, commentDetails, customPrompt } = params;
    return runExclusiveWorkspaceOperation({
      pendingMap: this.pendingFixes,
      workspaceId,
      logger,
      duplicateOperationMessage: 'PR review fix operation already in progress',
      operation: () =>
        dispatchFixWorkflow({
          workspaceId,
          workflow: PR_REVIEW_FIX_WORKFLOW,
          sessionName: 'PR Review Fixing',
          runningIdleAction: 'send_message',
          acquireAndDispatch: this.fixer.acquireAndDispatch.bind(this.fixer),
          buildPrompt: () => this.buildInitialPrompt(prUrl, prNumber, commentDetails, customPrompt),
          logger,
          startedLogMessage: 'PR review fixing session started',
          failureLogMessage: 'Failed to trigger PR review fix',
          startedLogMeta: { prNumber },
          errorLogMeta: { prUrl },
        }),
    });
  }

  isFixingInProgress(workspaceId: string): Promise<boolean> {
    return isFixWorkflowInProgress({
      workspaceId,
      workflow: PR_REVIEW_FIX_WORKFLOW,
      getActiveSession: (targetWorkspaceId, workflow) =>
        this.fixer.getActiveSession(targetWorkspaceId, workflow),
      isSessionWorking: (sessionId) => this.session.isSessionWorking(sessionId),
    });
  }

  async getActiveReviewFixSession(
    workspaceId: string
  ): Promise<{ id: string; status: string } | null> {
    return await this.fixer.getActiveSession(workspaceId, PR_REVIEW_FIX_WORKFLOW);
  }

  notifyReviewsAddressed(workspaceId: string): Promise<boolean> {
    return notifyFixWorkflowSession({
      workspaceId,
      workflow: PR_REVIEW_FIX_WORKFLOW,
      getActiveSession: (targetWorkspaceId, workflow) =>
        this.fixer.getActiveSession(targetWorkspaceId, workflow),
      getClient: (sessionId) => this.session.getClient(sessionId),
      message:
        '✅ **Reviews Addressed** - The review comments have been addressed. You can wrap up your current work.',
      logger,
      successLogMessage: 'Notified PR review fixing session that reviews were addressed',
      failureLogMessage: 'Failed to notify PR review session',
    });
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
