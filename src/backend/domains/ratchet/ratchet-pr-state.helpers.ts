import {
  SERVICE_CACHE_TTL_MS,
  SERVICE_INTERVAL_MS,
  SERVICE_THRESHOLDS,
} from '@/backend/services/constants';
import type { createLogger } from '@/backend/services/logger.service';
import type { RateLimitBackoff } from '@/backend/services/rate-limit-backoff';
import { CIStatus, RatchetState } from '@/shared/core';
import type { RatchetGitHubBridge } from './bridges';
import type {
  PRStateInfo,
  RatchetDecisionContext,
  RatchetStatusCheckRollupItem,
  WorkspaceWithPR,
} from './ratchet.types';

type Logger = ReturnType<typeof createLogger>;

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
]);

export function determineRatchetState(pr: PRStateInfo): RatchetState {
  if (pr.prState === 'MERGED') {
    return RatchetState.MERGED;
  }

  if (pr.prState !== 'OPEN') {
    return RatchetState.IDLE;
  }

  if (pr.ciStatus === CIStatus.PENDING || pr.ciStatus === CIStatus.UNKNOWN) {
    return RatchetState.CI_RUNNING;
  }

  if (pr.ciStatus === CIStatus.FAILURE) {
    return RatchetState.CI_FAILED;
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

  const failedChecks =
    statusChecks?.filter((check) =>
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
  statusChecks: RatchetStatusCheckRollupItem[] | null
): string {
  const ciKey = computeCiSnapshotKey(ciStatus, statusChecks);
  const reviewKey = `${hasChangesRequested ? 'changes-requested' : 'no-changes-requested'}:${
    latestReviewActivityAtMs ?? 'none'
  }`;
  return `${ciKey}|${reviewKey}`;
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

export function hasNewReviewActivitySinceLastDispatch(
  workspace: WorkspaceWithPR,
  prStateInfo: PRStateInfo,
  logger: Logger
): boolean {
  if (prStateInfo.latestReviewActivityAtMs === null) {
    return false;
  }

  if (!workspace.prReviewLastCheckedAt) {
    return true;
  }

  if (prStateInfo.latestReviewActivityAtMs > workspace.prReviewLastCheckedAt.getTime()) {
    return true;
  }

  // Self-heal: if the review check timestamp is stale and there's no active fixer session,
  // treat as new activity so the ratchet re-evaluates. This catches edge cases where a
  // dispatch was recorded but the session died through an unanticipated path.
  if (!workspace.ratchetActiveSessionId) {
    const age = Date.now() - workspace.prReviewLastCheckedAt.getTime();
    if (age > SERVICE_THRESHOLDS.ratchetReviewCheckStaleMs) {
      logger.info(
        'Review check timestamp is stale with no active session, treating as new activity',
        {
          workspaceId: workspace.id,
          checkedAtAge: Math.round(age / 1000),
        }
      );
      return true;
    }
  }

  return false;
}

export function shouldSkipCleanPR(
  workspace: WorkspaceWithPR,
  prStateInfo: PRStateInfo,
  logger: Logger
): boolean {
  if (prStateInfo.ciStatus !== CIStatus.SUCCESS || prStateInfo.hasChangesRequested) {
    return false;
  }

  return !hasNewReviewActivitySinceLastDispatch(workspace, prStateInfo, logger);
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
  decisionContext: RatchetDecisionContext | null,
  logger: Logger
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
          : hasNewReviewActivitySinceLastDispatch(workspace, prStateInfo, logger),
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
  github: RatchetGitHubBridge,
  logger: Logger
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
  logger: Logger;
  computeLatestReviewActivityAtMs?: (
    prDetails: {
      reviews: Array<{ submittedAt: string | null; author: { login: string } }>;
      comments: Array<{ updatedAt: string; author: { login: string } }>;
    },
    reviewComments: Array<{ updatedAt: string; author: { login: string } }>,
    authenticatedUsername: string | null
  ) => number | null;
  computeDispatchSnapshotKey?: (
    ciStatus: CIStatus,
    hasChangesRequested: boolean,
    latestReviewActivityAtMs: number | null,
    statusChecks: RatchetStatusCheckRollupItem[] | null
  ) => string;
}): Promise<PRStateInfo | null> {
  const {
    workspace,
    authenticatedUsername,
    github,
    backoff,
    logger,
    computeLatestReviewActivityAtMs:
      computeLatestReviewActivityAtMsFn = computeLatestReviewActivityAtMs,
    computeDispatchSnapshotKey: computeDispatchSnapshotKeyFn = computeDispatchSnapshotKey,
  } = params;
  const prContext = resolveRatchetPrContext(workspace, github, logger);
  if (!prContext) {
    return null;
  }

  try {
    const [prDetails, reviewComments] = await Promise.all([
      github.getPRFullDetails(prContext.repo, prContext.prNumber),
      github.getReviewComments(prContext.repo, prContext.prNumber),
    ]);

    const statusCheckRollup =
      prDetails.statusCheckRollup?.map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion ?? undefined,
        detailsUrl: check.detailsUrl,
      })) ?? null;

    const ciStatus = github.computeCIStatus(statusCheckRollup);

    const hasChangesRequested = prDetails.reviewDecision === 'CHANGES_REQUESTED';
    const latestReviewActivityAtMs = computeLatestReviewActivityAtMsFn(
      prDetails,
      reviewComments,
      authenticatedUsername
    );
    const snapshotKey = computeDispatchSnapshotKeyFn(
      ciStatus,
      hasChangesRequested,
      latestReviewActivityAtMs,
      statusCheckRollup
    );

    const filteredReviewComments = reviewComments
      .filter((c) => !isIgnoredReviewAuthor(c.author.login, authenticatedUsername))
      .map((c) => ({
        author: c.author.login,
        body: c.body,
        path: c.path,
        line: c.line,
        url: c.url,
      }));

    return {
      ciStatus,
      snapshotKey,
      hasChangesRequested,
      latestReviewActivityAtMs,
      statusCheckRollup,
      prState: prDetails.state,
      prNumber: prDetails.number,
      reviewComments: filteredReviewComments,
    };
  } catch (error) {
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
