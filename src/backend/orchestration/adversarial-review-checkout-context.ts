/**
 * Decides which code an adversarial reviewer can read for a PR. A workspace can
 * have several attached PRs but only one branch checked out, so reviewing any
 * other PR from the working tree would read the wrong code. See
 * docs/design/child-workspace-adversarial-review.md (section 5).
 */

import { toError } from '@/backend/lib/error-utils';
import type { ReviewCheckoutContext } from '@/backend/prompts/adversarial-review-dispatch';
import { createLogger } from '@/backend/services/logger.service';
import { APP_PRIVATE_REF_PREFIX, gitOpsService } from '@/backend/services/workspace';

const logger = createLogger('adversarial-review');

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type ReviewCheckoutGit = Pick<
  typeof gitOpsService,
  | 'getCheckoutIdentity'
  | 'isAncestorCommit'
  | 'hasCommit'
  | 'fetchPullRequestHead'
  | 'deletePrivateRef'
>;

export interface PrepareReviewCheckoutInput {
  worktreePath: string;
  /** `owner/repo` the PR belongs to. */
  repo: string;
  prNumber: number;
  /** Workspace PR association ID; names the private ref. */
  prId: string;
  /** PR head the diff was read at. */
  headSha: string;
  headRefName: string;
}

export interface PreparedReviewCheckout {
  context: ReviewCheckoutContext;
  /** Removes anything fetched for the review. Never throws. */
  cleanup: () => Promise<void>;
}

const noCleanup = () => Promise.resolve();

export function reviewRefForPr(prId: string): string {
  return `${APP_PRIVATE_REF_PREFIX}review/${prId.replaceAll(/[^A-Za-z0-9_-]/g, '_')}`;
}

export async function prepareReviewCheckout(
  input: PrepareReviewCheckoutInput,
  git: ReviewCheckoutGit = gitOpsService
): Promise<PreparedReviewCheckout> {
  const { worktreePath, repo, prNumber, prId, headSha, headRefName } = input;
  if (!COMMIT_SHA_PATTERN.test(headSha)) {
    throw new Error(`Invalid PR head SHA: ${headSha}`);
  }

  let identity: Awaited<ReturnType<ReviewCheckoutGit['getCheckoutIdentity']>>;
  try {
    identity = await git.getCheckoutIdentity(worktreePath);
  } catch (error) {
    logger.warn('Could not inspect worktree for adversarial review', {
      worktreePath,
      error: toError(error).message,
    });
    return {
      context: { kind: 'diff_only', headSha, reason: 'git_unavailable' },
      cleanup: noCleanup,
    };
  }

  const origin = identity.origin;
  if (!(origin && `${origin.owner}/${origin.repo}`.toLowerCase() === repo.toLowerCase())) {
    return {
      context: { kind: 'diff_only', headSha, reason: 'other_repository' },
      cleanup: noCleanup,
    };
  }

  // A matching branch name alone isn't proof: a fork PR can share the name, and
  // a stale local branch may lag the PR. Require the PR head to be in HEAD.
  if (
    identity.branch === headRefName &&
    identity.headSha !== null &&
    (await git.isAncestorCommit(worktreePath, headSha, identity.headSha).catch(() => false))
  ) {
    return {
      context: { kind: 'checked_out', headSha, localHeadSha: identity.headSha },
      cleanup: noCleanup,
    };
  }

  const ref = reviewRefForPr(prId);
  const cleanup = async () => {
    await git.deletePrivateRef(worktreePath, ref).catch((error) => {
      logger.warn('Failed to delete adversarial review ref', {
        worktreePath,
        ref,
        error: toError(error).message,
      });
    });
  };
  try {
    await git.fetchPullRequestHead(worktreePath, prNumber, ref);
    // The PR may have moved on since its diff was read; the reviewer must read
    // the same commit the diff and comment anchors describe.
    if (!(await git.hasCommit(worktreePath, headSha))) {
      throw new Error(`PR head ${headSha} is not available after fetching`);
    }
  } catch (error) {
    logger.warn('Falling back to a diff-only adversarial review', {
      worktreePath,
      prNumber,
      error: toError(error).message,
    });
    return { context: { kind: 'diff_only', headSha, reason: 'fetch_failed' }, cleanup };
  }
  return {
    context: { kind: 'fetched_head', headSha, worktreeBranch: identity.branch },
    cleanup,
  };
}
