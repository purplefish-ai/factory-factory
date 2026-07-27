import type { RatchetReviewTriggerMode } from '@prisma-gen/client';
import { SERVICE_CACHE_TTL_MS, SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { createLogger } from '@/backend/services/logger.service';
import type { RateLimitBackoff } from '@/backend/services/rate-limit-backoff';
import {
  CIStatus,
  deriveRatchetState,
  PRState,
  type RatchetState,
  reduceCheckRollupToLatestRunAttempts,
} from '@/shared/core';
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

/**
 * The ratchet state implied by a live PR fetch, before any of it is persisted.
 *
 * A thin adapter over the shared `deriveRatchetState` so a check and a later read
 * of the same workspace cannot disagree. The two differ only in vocabulary: this
 * has GitHub's raw `state` (`OPEN`/`CLOSED`/`MERGED`) and a `hasChangesRequested`
 * boolean, where the cache has the enriched `PRState` and the raw
 * `reviewDecision`. Callers are already inside a check with a fetch in hand, so
 * `ratchetEnabled` is true by construction — the poll query filters on it and
 * `processWorkspace` returns early otherwise.
 */
export function determineRatchetState(pr: PRStateInfo): RatchetState {
  return deriveRatchetState({
    ratchetEnabled: true,
    prState: toCachedPRState(pr.prState),
    prCiStatus: pr.ciStatus,
    prHasMergeConflict: pr.hasMergeConflict,
    prReviewState: pr.hasChangesRequested ? 'CHANGES_REQUESTED' : null,
  });
}

/** GitHub's raw PR state, in the vocabulary `WorkspacePR.state` uses. */
function toCachedPRState(rawState: string): PRState {
  if (rawState === 'MERGED') {
    return PRState.MERGED;
  }
  if (rawState === 'OPEN') {
    return PRState.OPEN;
  }
  return PRState.CLOSED;
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
  prNumber: number,
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
  return `pr:${prNumber}|${ciKey}|${reviewKey}|merge:${mergeKey}`;
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
    author: { login: string };
    state?: string;
  }>
): Map<string, Array<{ index: number; submittedAtMs: number | null }>> {
  const approvedReviewsByAuthor = new Map<
    string,
    Array<{ index: number; submittedAtMs: number | null }>
  >();

  reviews.forEach((review, index) => {
    if (review.state?.toUpperCase() !== 'APPROVED') {
      return;
    }

    const approvedReviews = approvedReviewsByAuthor.get(review.author.login) ?? [];
    approvedReviews.push({ index, submittedAtMs: parseSubmittedAtMs(review.submittedAt) });
    approvedReviewsByAuthor.set(review.author.login, approvedReviews);
  });

  return approvedReviewsByAuthor;
}

function wasReviewSupersededByApproval(
  review: { submittedAt?: string | null; author: { login: string } },
  reviewIndex: number,
  approvedReviewsByAuthor: Map<string, Array<{ index: number; submittedAtMs: number | null }>>
): boolean {
  const submittedAtMs = parseSubmittedAtMs(review.submittedAt);
  const approvedReviews = approvedReviewsByAuthor.get(review.author.login) ?? [];

  return approvedReviews.some((approval) => {
    if (submittedAtMs !== null && approval.submittedAtMs !== null) {
      return approval.submittedAtMs > submittedAtMs;
    }

    return approval.index > reviewIndex;
  });
}

export function computeLatestReviewActivityAtMs(
  prDetails: {
    reviews: Array<{
      submittedAt: string | null;
      author: { login: string };
      state?: string;
      body?: string;
    }>;
    comments: Array<{ updatedAt: string; author: { login: string } }>;
  },
  reviewComments: Array<{ updatedAt: string; author: { login: string } }>,
  authenticatedUsername: string | null,
  reviewTriggerMode: RatchetReviewTriggerMode
): number | null {
  const approvedReviewsByAuthor = getApprovedReviewsByAuthor(prDetails.reviews);
  const entries = [
    ...prDetails.reviews
      .filter((review, index) => {
        if (wasReviewSupersededByApproval(review, index, approvedReviewsByAuthor)) {
          return false;
        }

        const state = review.state?.toUpperCase();
        return (
          state === 'CHANGES_REQUESTED' ||
          (reviewTriggerMode === 'ALL_REVIEW_FEEDBACK' &&
            state === 'COMMENTED' &&
            (review.body?.trim().length ?? 0) > 0)
        );
      })
      .map((review) => ({
        authorLogin: review.author.login,
        timestamp: review.submittedAt,
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

export function buildReviewSummariesForPrompt(
  prDetails: {
    url: string;
    reviews: Array<{
      submittedAt?: string | null;
      author: { login: string };
      state?: string;
      body?: string;
      url?: string;
    }>;
  },
  authenticatedUsername: string | null,
  reviewTriggerMode: RatchetReviewTriggerMode
): PRStateInfo['reviewComments'] {
  const approvedReviewsByAuthor = getApprovedReviewsByAuthor(prDetails.reviews);

  return prDetails.reviews
    .filter((review, index) => {
      if (isIgnoredReviewAuthor(review.author.login, authenticatedUsername)) {
        return false;
      }

      const state = review.state?.toUpperCase() ?? '';

      if (wasReviewSupersededByApproval(review, index, approvedReviewsByAuthor)) {
        return false;
      }

      if (
        state !== 'CHANGES_REQUESTED' &&
        !(reviewTriggerMode === 'ALL_REVIEW_FEEDBACK' && state === 'COMMENTED')
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
  if (
    prStateInfo.ciStatus !== CIStatus.SUCCESS ||
    prStateInfo.hasChangesRequested ||
    (prStateInfo.reviewComments?.length ?? 0) > 0
  ) {
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
      previousDispatchSnapshotKey: workspace.ratchetDispatchSnapshotKey,
      currentSnapshotKey: prStateInfo.snapshotKey,
      changedSinceLastDispatch:
        decisionContext?.hasStateChangedSinceLastDispatch ??
        workspace.ratchetDispatchSnapshotKey !== prStateInfo.snapshotKey,
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
  reviewTriggerMode: RatchetReviewTriggerMode;
  github: RatchetGitHubBridge;
  backoff: RateLimitBackoff;
  signal?: AbortSignal;
  /**
   * Skip the completed-fetch cooldown. Used by event-driven checks that fire
   * right after another service's fetch completed — the whole point of those
   * checks is to recompute now. An actively in-flight fetch is still honored,
   * so the bypass never issues a duplicate concurrent GitHub call.
   */
  bypassRecentFetchCooldown?: boolean;
}): Promise<PRStateFetchResult> {
  const { workspace, authenticatedUsername, reviewTriggerMode, github, backoff, signal } = params;
  signal?.throwIfAborted();
  const prContext = resolveRatchetPrContext(workspace, github);
  if (!prContext) {
    return null;
  }

  try {
    signal?.throwIfAborted();
    // The coordinator claims the workspace before the fetch yields, so a
    // concurrent PR sync sees it in flight and skips its own call — and
    // releasing that claim is its `finally`, not this function's obligation.
    const outcome = await github.coordinatePrFetch(
      workspace.id,
      () =>
        fetchPRStateNow({
          workspace,
          prContext,
          authenticatedUsername,
          reviewTriggerMode,
          github,
          signal,
        }),
      { ignoreCooldown: params.bypassRecentFetchCooldown ?? false }
    );

    if (outcome.status === 'skipped') {
      logger.debug('Skipping ratchet PR fetch because workspace was recently fetched', {
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
      });
      return { skipped: true, reason: 'recently_fetched' };
    }

    return outcome.value;
  } catch (error) {
    signal?.throwIfAborted();
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

/**
 * The fetch itself, with the dedup decision and the error handling lifted out.
 * Runs inside the coordinator's claim: returning normally records the fetch,
 * throwing releases the claim so the workspace stays eligible for a retry.
 */
async function fetchPRStateNow(params: {
  workspace: WorkspaceWithPR;
  prContext: { repo: string; prNumber: number };
  authenticatedUsername: string | null;
  reviewTriggerMode: RatchetReviewTriggerMode;
  github: RatchetGitHubBridge;
  signal?: AbortSignal;
}): Promise<PRStateInfo> {
  const { workspace, prContext, authenticatedUsername, reviewTriggerMode, github, signal } = params;

  const [prDetails, reviewComments, resolvedReviewCommentIds] = await Promise.all([
    github.getPRFullDetails(prContext.repo, prContext.prNumber, signal),
    github.getReviewComments(prContext.repo, prContext.prNumber, undefined, signal),
    // Degrade gracefully: without resolution data, fall back to including
    // all review comments (pre-filtering behavior) rather than failing the check.
    github
      .getResolvedReviewCommentIds(prContext.repo, prContext.prNumber, signal)
      .catch((error) => {
        signal?.throwIfAborted();
        logger.warn('Failed to fetch resolved review threads; including all review comments', {
          workspaceId: workspace.id,
          prUrl: workspace.prUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        return new Set<number>();
      }),
  ]);
  signal?.throwIfAborted();

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
  const reviewDecision = prDetails.reviewDecision ?? null;
  // The same observation in the cache's vocabulary, computed by the github
  // capsule's mapper so this writer and the PR-sync poller agree on it.
  const cachedPrState = github.computePRState({
    state: prDetails.state,
    isDraft: prDetails.isDraft,
    reviewDecision,
  });
  // Review activity (and thus the dispatch snapshot key) is computed over ALL
  // review comments, resolved or not. Resolving a thread does not touch the
  // comments' timestamps, so this keeps the snapshot key stable when threads
  // get resolved; excluding resolved comments would change the key on every
  // resolution and re-trigger dispatches.
  const latestReviewActivityAtMs = computeLatestReviewActivityAtMs(
    prDetails,
    reviewComments,
    authenticatedUsername,
    reviewTriggerMode
  );
  const snapshotKey = computeDispatchSnapshotKey(
    prDetails.number,
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
  const reviewSummaries = buildReviewSummariesForPrompt(
    prDetails,
    authenticatedUsername,
    reviewTriggerMode
  );

  // Last chance to give up before this counts as a completed fetch.
  signal?.throwIfAborted();

  return {
    ciStatus,
    snapshotKey,
    hasChangesRequested,
    hasMergeConflict,
    latestReviewActivityAtMs,
    statusCheckRollup: reducedStatusCheckRollup,
    prState: prDetails.state,
    cachedPrState,
    reviewDecision,
    prNumber: prDetails.number,
    reviewComments: [...filteredReviewComments, ...reviewSummaries],
  };
}

export async function getAuthenticatedUsernameCached(params: {
  cachedValue: AuthenticatedUsernameCache | null;
  github: RatchetGitHubBridge;
  signal?: AbortSignal;
}): Promise<{ username: string | null; cache: AuthenticatedUsernameCache }> {
  params.signal?.throwIfAborted();
  const nowMs = Date.now();
  if (params.cachedValue && params.cachedValue.expiresAtMs > nowMs) {
    return {
      username: params.cachedValue.value,
      cache: params.cachedValue,
    };
  }

  params.signal?.throwIfAborted();
  const username = await params.github.getAuthenticatedUsername(params.signal);
  params.signal?.throwIfAborted();
  return {
    username,
    cache: {
      value: username,
      expiresAtMs: nowMs + SERVICE_CACHE_TTL_MS.ratchetAuthenticatedUsername,
    },
  };
}
