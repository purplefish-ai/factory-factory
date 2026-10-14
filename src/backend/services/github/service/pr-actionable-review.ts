import type { RatchetReviewTriggerMode } from '@prisma-gen/client';
import { hasAdversarialReviewMarker } from '@/shared/adversarial-review';
import type { GitHubReview } from '@/shared/github-types';
export function isIgnoredReviewAuthor(
  authorLogin: string,
  authenticatedUsername: string | null
): boolean {
  if (!authenticatedUsername) {
    return false;
  }

  return authorLogin === authenticatedUsername;
}

/**
 * Whether a review carries the adversarial-review marker *and* was actually
 * posted by this app's own authenticated GitHub identity. Requiring both
 * matters for two different reasons on the two call sites below: it exempts
 * the app's own marker-tagged reviews from the "ignore reviews I authored"
 * filter (otherwise a self-posted adversarial review could never become
 * actionable feedback), and it stops any other GitHub user from spoofing an
 * adversarial review by copying the public marker text into their own review
 * — a spoofed review's author never matches, so it's treated as an ordinary
 * review instead of dispatch-worthy, untrusted-content-bearing feedback.
 */
export function isOwnAdversarialReviewMarker(
  review: { author: GitHubReview['author']; body?: string },
  authenticatedUsername: string | null
): boolean {
  return (
    authenticatedUsername !== null &&
    review.author.login === authenticatedUsername &&
    hasAdversarialReviewMarker(review.body)
  );
}

function parseSubmittedAtMs(submittedAt: string | null | undefined): number | null {
  if (!submittedAt) {
    return null;
  }

  const timestamp = Date.parse(submittedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getApprovedReviewsByAuthor(
  reviews: Array<{
    submittedAt?: string | null;
    chronologicalOrder?: number;
    author: GitHubReview['author'];
    state?: string;
  }>
): Map<string, Array<{ chronologicalOrder?: number; submittedAtMs: number | null }>> {
  const approvedReviewsByAuthor = new Map<
    string,
    Array<{ chronologicalOrder?: number; submittedAtMs: number | null }>
  >();

  reviews.forEach((review) => {
    if (review.author.isUnknown || review.state?.toUpperCase() !== 'APPROVED') {
      return;
    }

    const approvedReviews = approvedReviewsByAuthor.get(review.author.login) ?? [];
    approvedReviews.push({
      chronologicalOrder: review.chronologicalOrder,
      submittedAtMs: parseSubmittedAtMs(review.submittedAt),
    });
    approvedReviewsByAuthor.set(review.author.login, approvedReviews);
  });

  return approvedReviewsByAuthor;
}

function wasReviewSupersededByApproval(
  review: {
    submittedAt?: string | null;
    chronologicalOrder?: number;
    author: GitHubReview['author'];
  },
  approvedReviewsByAuthor: Map<
    string,
    Array<{ chronologicalOrder?: number; submittedAtMs: number | null }>
  >
): boolean {
  if (review.author.isUnknown) {
    return false;
  }
  const submittedAtMs = parseSubmittedAtMs(review.submittedAt);
  const approvedReviews = approvedReviewsByAuthor.get(review.author.login) ?? [];

  return approvedReviews.some((approval) => {
    if (
      submittedAtMs !== null &&
      approval.submittedAtMs !== null &&
      approval.submittedAtMs !== submittedAtMs
    ) {
      return approval.submittedAtMs > submittedAtMs;
    }

    // Only explicit API chronology can disambiguate ties or missing times.
    return (
      review.chronologicalOrder !== undefined &&
      approval.chronologicalOrder !== undefined &&
      approval.chronologicalOrder > review.chronologicalOrder
    );
  });
}

export function computeLatestReviewActivityAtMs(
  prDetails: {
    reviews: Array<{
      submittedAt: string | null;
      chronologicalOrder?: number;
      author: GitHubReview['author'];
      state?: string;
      body?: string;
    }>;
    comments: Array<{ updatedAt: string; author: GitHubReview['author']; body?: string }>;
  },
  reviewComments: Array<{ updatedAt: string; author: GitHubReview['author'] }>,
  authenticatedUsername: string | null,
  reviewTriggerMode: RatchetReviewTriggerMode
): number | null {
  const approvedReviewsByAuthor = getApprovedReviewsByAuthor(prDetails.reviews);
  const entries = [
    ...prDetails.reviews
      .filter((review) => {
        if (wasReviewSupersededByApproval(review, approvedReviewsByAuthor)) {
          return false;
        }

        const state = review.state?.toUpperCase();
        return (
          state === 'CHANGES_REQUESTED' ||
          (reviewTriggerMode === 'ALL_REVIEW_FEEDBACK' &&
            state === 'COMMENTED' &&
            (review.body?.trim().length ?? 0) > 0) ||
          // An adversarial-review finding is an explicit, on-demand request for
          // feedback (the user clicked the button), so it counts as actionable
          // regardless of the admin's ambient review-trigger-mode setting.
          (state === 'COMMENTED' && isOwnAdversarialReviewMarker(review, authenticatedUsername))
        );
      })
      .map((review) => ({
        authorLogin: review.author.login,
        timestamp: review.submittedAt,
        bypassAuthorFilter: isOwnAdversarialReviewMarker(review, authenticatedUsername),
      })),
    ...reviewComments.map((reviewComment) => ({
      authorLogin: reviewComment.author.login,
      timestamp: reviewComment.updatedAt,
      bypassAuthorFilter: false,
    })),
    ...prDetails.comments
      .filter((comment) => isOwnAdversarialReviewMarker(comment, authenticatedUsername))
      .map((comment) => ({
        authorLogin: comment.author.login,
        timestamp: comment.updatedAt,
        bypassAuthorFilter: true,
      })),
  ];

  const timestamps = entries
    .filter(
      (entry): entry is { authorLogin: string; timestamp: string; bypassAuthorFilter: boolean } =>
        entry.timestamp !== null &&
        (entry.bypassAuthorFilter ||
          !isIgnoredReviewAuthor(entry.authorLogin, authenticatedUsername))
    )
    .map((entry) => Date.parse(entry.timestamp))
    .filter((timestamp) => Number.isFinite(timestamp));

  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

export function buildReviewSummariesForPrompt(
  prDetails: {
    url: string;
    reviews: Array<{
      submittedAt?: string | null;
      chronologicalOrder?: number;
      author: GitHubReview['author'];
      state?: string;
      body?: string;
      url?: string;
    }>;
    comments?: Array<{ author: GitHubReview['author']; body?: string; url?: string }>;
  },
  authenticatedUsername: string | null,
  reviewTriggerMode: RatchetReviewTriggerMode
): Array<{ author: string; body: string; path: string; line: number | null; url: string }> {
  const approvedReviewsByAuthor = getApprovedReviewsByAuthor(prDetails.reviews);

  const reviewSummaries = prDetails.reviews
    .filter((review) => {
      const isOwnMarkerReview = isOwnAdversarialReviewMarker(review, authenticatedUsername);

      if (isIgnoredReviewAuthor(review.author.login, authenticatedUsername) && !isOwnMarkerReview) {
        return false;
      }

      const state = review.state?.toUpperCase() ?? '';

      if (wasReviewSupersededByApproval(review, approvedReviewsByAuthor)) {
        return false;
      }

      if (
        state !== 'CHANGES_REQUESTED' &&
        !(reviewTriggerMode === 'ALL_REVIEW_FEEDBACK' && state === 'COMMENTED') &&
        !(state === 'COMMENTED' && isOwnMarkerReview)
      ) {
        return false;
      }

      return (review.body?.trim().length ?? 0) > 0;
    })
    .map((review) => ({
      author: review.author.login,
      body: review.body?.trim() ?? '',
      path: 'PR review',
      line: null,
      url: review.url ?? prDetails.url,
    }));

  // The fallback posts a conversation summary, including findings without
  // diff anchors. Only the authenticated app's marker may opt into Ratchet.
  return [
    ...reviewSummaries,
    ...(prDetails.comments ?? [])
      .filter((comment) => isOwnAdversarialReviewMarker(comment, authenticatedUsername))
      .map((comment) => ({
        author: comment.author.login,
        body: comment.body?.trim() ?? '',
        path: 'PR review',
        line: null,
        url: comment.url ?? prDetails.url,
      })),
  ];
}

export function selectActionableReviews(
  reviews: GitHubReview[],
  authenticatedUsername: string | null,
  reviewTriggerMode: RatchetReviewTriggerMode
) {
  const approvals = getApprovedReviewsByAuthor(reviews);
  return reviews.filter((review) => {
    const marker = isOwnAdversarialReviewMarker(review, authenticatedUsername);
    return (
      (!isIgnoredReviewAuthor(review.author.login, authenticatedUsername) || marker) &&
      !wasReviewSupersededByApproval(review, approvals) &&
      (review.state === 'CHANGES_REQUESTED' ||
        (review.state === 'COMMENTED' &&
          (reviewTriggerMode === 'ALL_REVIEW_FEEDBACK' || marker))) &&
      !!review.body?.trim()
    );
  });
}
