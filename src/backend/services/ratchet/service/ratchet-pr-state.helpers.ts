import { SERVICE_CACHE_TTL_MS, SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { createLogger } from '@/backend/services/logger.service';
import type { RateLimitBackoff } from '@/backend/services/rate-limit-backoff';
import { CIStatus, RatchetState, reduceCheckRollupToLatestRunAttempts } from '@/shared/core';
import type { RatchetGitHubBridge } from './bridges';
import type {
  PRStateFetchResult,
  PRStateFetchSkipped,
  PRStateInfo,
  RatchetDecisionContext,
  RatchetStatusCheckRollupItem,
  WorkspaceWithPR,
} from './ratchet.types';

const logger = createLogger('ratchet');

export interface AuthenticatedUsernameCache {
  value: string | null;
  expiresAtMs: number;
}

const FAILURE_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ERROR',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

export function isPRStateFetchSkipped(result: PRStateFetchResult): result is PRStateFetchSkipped {
  return result !== null && 'skipped' in result && result.skipped === true;
}

export function determineRatchetState(pr: PRStateInfo): RatchetState {
  if (pr.prState === 'MERGED') {
    return RatchetState.MERGED;
  }

  if (pr.prState !== 'OPEN') {
    return RatchetState.IDLE;
  }

  if (pr.ciStatus === CIStatus.FAILURE) {
    return RatchetState.CI_FAILED;
  }

  // Check merge conflicts before CI pending/unknown — a PR can have conflicts
  // even when there are no CI checks configured, and conflicts are independently
  // actionable regardless of CI status.
  if (pr.hasMergeConflict) {
    return RatchetState.MERGE_CONFLICT;
  }

  if (pr.ciStatus === CIStatus.PENDING || pr.ciStatus === CIStatus.UNKNOWN) {
    return RatchetState.CI_RUNNING;
  }

  if (pr.hasChangesRequested) {
    return RatchetState.REVIEW_PENDING;
  }

  return RatchetState.READY;
}

export function computeCiSnapshotKey(
  ciStatus: CIStatus,
  statusChecks: RatchetStatusCheckRollupItem[] | null
): string {
  if (ciStatus !== CIStatus.FAILURE) {
    return `ci:${ciStatus}`;
  }

  const reducedStatusChecks = reduceCheckRollupToLatestRunAttempts(statusChecks);
  const failedChecks =
    reducedStatusChecks?.filter((check) =>
      FAILURE_CONCLUSIONS.has(check.conclusion?.toUpperCase() ?? '')
    ) ?? [];

  if (failedChecks.length === 0) {
    return 'ci:FAILURE:unknown';
  }

  const signature = failedChecks
    .map((check) => {
      const runIdMatch = check.detailsUrl?.match(/\/actions\/runs\/(\d+)/);
      const runId = runIdMatch?.[1];
      const stableCheckIdentity = runId ?? check.detailsUrl ?? 'no-run-id-or-details-url';
      return `${check.name ?? 'unknown'}:${check.conclusion ?? 'UNKNOWN'}:${stableCheckIdentity}`;
    })
    .sort()
    .join('|');

  return `ci:FAILURE:${signature}`;
}

export function computeDispatchSnapshotKey(
  ciStatus: CIStatus,
  hasChangesRequested: boolean,
  latestReviewActivityAtMs: number | null,
  statusChecks: RatchetStatusCheckRollupItem[] | null,
  hasMergeConflict?: boolean
): string {
  const ciKey = computeCiSnapshotKey(ciStatus, statusChecks);
  const reviewKey = `${hasChangesRequested ? 'changes-requested' : 'no-changes-requested'}:${
    latestReviewActivityAtMs ?? 'none'
  }`;
  const mergeKey = hasMergeConflict ? 'conflict' : 'clean';
  return `${ciKey}|${reviewKey}|merge:${mergeKey}`;
}

export function isIgnoredReviewAuthor(
  authorLogin: string,
  authenticatedUsername: string | null
): boolean {
  if (!authenticatedUsername) {
    return false;
  }

  return authorLogin === authenticatedUsername;
}

export function computeLatestReviewActivityAtMs(
  prDetails: {
    reviews: Array<{ submittedAt: string | null; author: { login: string } }>;
    comments: Array<{ updatedAt: string; author: { login: string } }>;
  },
  reviewComments: Array<{ updatedAt: string; author: { login: string } }>,
  authenticatedUsername: string | null
): number | null {
  const entries = [
    ...prDetails.reviews.map((review) => ({
      authorLogin: review.author.login,
      timestamp: review.submittedAt,
    })),
    ...prDetails.comments.map((comment) => ({
      authorLogin: comment.author.login,
      timestamp: comment.updatedAt,
    })),
    ...reviewComments.map((reviewComment) => ({
      authorLogin: reviewComment.author.login,
      timestamp: reviewComment.updatedAt,
    })),
  ];

  const timestamps = entries
    .filter(
      (entry): entry is { authorLogin: string; timestamp: string } =>
        entry.timestamp !== null && !isIgnoredReviewAuthor(entry.authorLogin, authenticatedUsername)
    )
    .map((entry) => Date.parse(entry.timestamp))
    .filter((timestamp) => Number.isFinite(timestamp));

  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

const ACTIONABLE_REVIEW_STATES = new Set(['COMMENTED', 'CHANGES_REQUESTED']);

export function buildReviewSummariesForPrompt(
  prDetails: {
    url: string;
    reviews: Array<{
      author: { login: string };
      state?: string;
      body?: string;
      url?: string;
    }>;
  },
  authenticatedUsername: string | null
): PRStateInfo['reviewComments'] {
  // A CHANGES_REQUESTED review is stale once the same reviewer approves later,
  // even if they leave further COMMENTED reviews after the approval.
  const lastApprovedIndexByAuthor = new Map<string, number>();

  prDetails.reviews.forEach((review, index) => {
    if (review.state?.toUpperCase() === 'APPROVED') {
      lastApprovedIndexByAuthor.set(review.author.login, index);
    }
  });

  return prDetails.reviews
    .filter((review, index) => {
      if (isIgnoredReviewAuthor(review.author.login, authenticatedUsername)) {
        return false;
      }

      const state = review.state?.toUpperCase() ?? '';

      if (
        state === 'CHANGES_REQUESTED' &&
        (lastApprovedIndexByAuthor.get(review.author.login) ?? -1) > index
      ) {
        return false;
      }

      if (!ACTIONABLE_REVIEW_STATES.has(state)) {
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
}

export function hasNewReviewActivitySinceLastDispatch(
  workspace: WorkspaceWithPR,
  prStateInfo: PRStateInfo
): boolean {
  if (prStateInfo.latestReviewActivityAtMs === null) {
    return false;
  }

  if (!workspace.prReviewLastCheckedAt) {
    return true;
  }

  return prStateInfo.latestReviewActivityAtMs > workspace.prReviewLastCheckedAt.getTime();
}

export function shouldSkipCleanPR(workspace: WorkspaceWithPR, prStateInfo: PRStateInfo): boolean {
  if (prStateInfo.ciStatus !== CIStatus.SUCCESS || prStateInfo.hasChangesRequested) {
    return false;
  }

  if (prStateInfo.hasMergeConflict) {
    return false;
  }

  return !hasNewReviewActivitySinceLastDispatch(workspace, prStateInfo);
}

export function buildSnapshotDiagnostics(
  workspace: WorkspaceWithPR,
  prStateInfo: PRStateInfo | null,
  decisionContext: RatchetDecisionContext | null
) {
  if (!prStateInfo) {
    return {
      ciSnapshotKey: null,
      snapshotComparison: null,
    };
  }

  return {
    ciSnapshotKey: computeCiSnapshotKey(prStateInfo.ciStatus, prStateInfo.statusCheckRollup),
    snapshotComparison: {
      previousDispatchSnapshotKey: workspace.ratchetLastCiRunId,
      currentSnapshotKey: prStateInfo.snapshotKey,
      changedSinceLastDispatch:
        decisionContext?.hasStateChangedSinceLastDispatch ??
        workspace.ratchetLastCiRunId !== prStateInfo.snapshotKey,
    },
  };
}

export function buildReviewTimestampDiagnostics(
  workspace: WorkspaceWithPR,
  prStateInfo: PRStateInfo | null,
  decisionContext: RatchetDecisionContext | null
) {
  const latestReviewActivityAtMs = prStateInfo?.latestReviewActivityAtMs ?? null;
  const prReviewLastCheckedAtMs = workspace.prReviewLastCheckedAt?.getTime() ?? null;
  const deltaMs =
    latestReviewActivityAtMs !== null && prReviewLastCheckedAtMs !== null
      ? latestReviewActivityAtMs - prReviewLastCheckedAtMs
      : null;

  if (!prStateInfo) {
    return {
      latestReviewActivityAtMs,
      reviewTimestampComparison: null,
    };
  }

  return {
    latestReviewActivityAtMs,
    reviewTimestampComparison: {
      prReviewLastCheckedAt: workspace.prReviewLastCheckedAt?.toISOString() ?? null,
      latestReviewActivityAt:
        latestReviewActivityAtMs !== null ? new Date(latestReviewActivityAtMs).toISOString() : null,
      prReviewLastCheckedAtMs,
      latestReviewActivityAtMs,
      deltaMs,
      hasNewReviewActivitySinceLastDispatch:
        decisionContext?.hasNewReviewActivitySinceLastDispatch !== undefined
          ? decisionContext.hasNewReviewActivitySinceLastDispatch
          : hasNewReviewActivitySinceLastDispatch(workspace, prStateInfo),
    },
  };
}

export function buildFailedCheckDiagnostics(prStateInfo: PRStateInfo | null) {
  return (
    prStateInfo?.statusCheckRollup
      ?.filter((check) => FAILURE_CONCLUSIONS.has(check.conclusion?.toUpperCase() ?? ''))
      .map((check) => {
        const runIdMatch = check.detailsUrl?.match(/\/actions\/runs\/(\d+)/);
        return {
          name: check.name ?? 'unknown',
          status: check.status ?? null,
          conclusion: check.conclusion ?? null,
          runId: runIdMatch?.[1] ?? null,
          detailsUrl: check.detailsUrl ?? null,
        };
      }) ?? []
  );
}

export function resolveRatchetPrContext(
  workspace: WorkspaceWithPR,
  github: RatchetGitHubBridge
): { repo: string; prNumber: number } | null {
  const prInfo = github.extractPRInfo(workspace.prUrl);
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

export async function fetchPRState(params: {
  workspace: WorkspaceWithPR;
  authenticatedUsername: string | null;
  github: RatchetGitHubBridge;
  backoff: RateLimitBackoff;
  /**
   * Skip the completed-fetch cooldown. Used by event-driven checks that fire
   * right after another service's fetch registered the workspace in the dedup
   * registry — the whole point of those checks is to recompute now. An
   * actively in-flight fetch is still honored, so the bypass never issues a
   * duplicate concurrent GitHub call.
   */
  bypassRecentFetchCooldown?: boolean;
}): Promise<PRStateFetchResult> {
  const { workspace, authenticatedUsername, github, backoff } = params;
  const prContext = resolveRatchetPrContext(workspace, github);
  if (!prContext) {
    return null;
  }

  const dedupSkip = params.bypassRecentFetchCooldown
    ? github.isFetchInFlight(workspace.id)
    : github.isRecentlyFetched(workspace.id);
  if (dedupSkip) {
    logger.debug('Skipping ratchet PR fetch because workspace was recently fetched', {
      workspaceId: workspace.id,
      prUrl: workspace.prUrl,
    });
    return { skipped: true, reason: 'recently_fetched' };
  }

  try {
    // Claim this workspace as in-flight before the async fetch so concurrent
    // scheduler/ratchet calls see it and skip redundant fetches.
    github.startFetch(workspace.id);

    const [prDetails, reviewComments, resolvedReviewCommentIds] = await Promise.all([
      github.getPRFullDetails(prContext.repo, prContext.prNumber),
      github.getReviewComments(prContext.repo, prContext.prNumber),
      // Degrade gracefully: without resolution data, fall back to including
      // all review comments (pre-filtering behavior) rather than failing the check.
      github.getResolvedReviewCommentIds(prContext.repo, prContext.prNumber).catch((error) => {
        logger.warn('Failed to fetch resolved review threads; including all review comments', {
          workspaceId: workspace.id,
          prUrl: workspace.prUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        return new Set<number>();
      }),
    ]);

    const statusCheckRollup =
      prDetails.statusCheckRollup?.map((check) => ({
        name: check.name,
        workflowName: check.workflowName,
        status: check.status,
        conclusion: check.conclusion ?? undefined,
        detailsUrl: check.detailsUrl,
        startedAt: check.startedAt,
        completedAt: check.completedAt,
      })) ?? null;

    const reducedStatusCheckRollup = reduceCheckRollupToLatestRunAttempts(statusCheckRollup);
    const ciStatus = github.computeCIStatus(reducedStatusCheckRollup);

    const hasChangesRequested = prDetails.reviewDecision === 'CHANGES_REQUESTED';
    const hasMergeConflict = prDetails.mergeStateStatus === 'DIRTY';
    // Review activity (and thus the dispatch snapshot key) is computed over ALL
    // review comments, resolved or not. Resolving a thread does not touch the
    // comments' timestamps, so this keeps the snapshot key stable when threads
    // get resolved; excluding resolved comments would change the key on every
    // resolution and re-trigger dispatches.
    const latestReviewActivityAtMs = computeLatestReviewActivityAtMs(
      prDetails,
      reviewComments,
      authenticatedUsername
    );
    const snapshotKey = computeDispatchSnapshotKey(
      ciStatus,
      hasChangesRequested,
      latestReviewActivityAtMs,
      reducedStatusCheckRollup,
      hasMergeConflict
    );

    // Resolved threads are settled feedback: drop them from the fixer prompt
    // and from the actionable-trigger count so they cannot re-trigger or
    // re-litigate dispatches.
    const filteredReviewComments = reviewComments
      .filter(
        (c) =>
          !(
            resolvedReviewCommentIds.has(c.id) ||
            isIgnoredReviewAuthor(c.author.login, authenticatedUsername)
          )
      )
      .map((c) => ({
        author: c.author.login,
        body: c.body,
        path: c.path,
        line: c.line,
        url: c.url,
      }));
    if (filteredReviewComments.length < reviewComments.length) {
      logger.debug('Filtered review comments for ratchet dispatch', {
        workspaceId: workspace.id,
        totalComments: reviewComments.length,
        includedComments: filteredReviewComments.length,
        resolvedThreadCommentIds: resolvedReviewCommentIds.size,
      });
    }
    const reviewSummaries = buildReviewSummariesForPrompt(prDetails, authenticatedUsername);

    // Record successful fetch completion so the dedup registry tracks this workspace.
    github.registerFetch(workspace.id);

    return {
      ciStatus,
      snapshotKey,
      hasChangesRequested,
      hasMergeConflict,
      latestReviewActivityAtMs,
      statusCheckRollup: reducedStatusCheckRollup,
      prState: prDetails.state,
      prNumber: prDetails.number,
      reviewComments: [...filteredReviewComments, ...reviewSummaries],
    };
  } catch (error) {
    // Release the in-flight claim so the workspace is eligible for a future retry.
    github.cancelFetch(workspace.id);
    backoff.handleError(
      error,
      logger,
      'Ratchet',
      { workspaceId: workspace.id, prUrl: workspace.prUrl },
      SERVICE_INTERVAL_MS.ratchetPoll
    );
    return null;
  }
}

export async function getAuthenticatedUsernameCached(params: {
  cachedValue: AuthenticatedUsernameCache | null;
  github: RatchetGitHubBridge;
}): Promise<{ username: string | null; cache: AuthenticatedUsernameCache }> {
  const nowMs = Date.now();
  if (params.cachedValue && params.cachedValue.expiresAtMs > nowMs) {
    return {
      username: params.cachedValue.value,
      cache: params.cachedValue,
    };
  }

  const username = await params.github.getAuthenticatedUsername();
  return {
    username,
    cache: {
      value: username,
      expiresAtMs: nowMs + SERVICE_CACHE_TTL_MS.ratchetAuthenticatedUsername,
    },
  };
}
