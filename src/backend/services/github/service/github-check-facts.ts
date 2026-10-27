import {
  deriveCiStatusFromCheckRollup,
  reduceCheckRollupToLatestRunAttempts,
} from '@/shared/core/ci-status';
import type { GitHubStatusCheck } from '@/shared/github-types';

function timestamp(value: string | null | undefined): string | null {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Normalize already-mapped GitHub checks without observation or runtime dependencies. */
export function normalizeGitHubCheckFacts(rollup: GitHubStatusCheck[] | null) {
  const checks =
    reduceCheckRollupToLatestRunAttempts(rollup)?.map((c) => ({
      identity: c.detailsUrl || `${c.workflowName ?? ''}:${c.name ?? ''}`,
      attempt: null,
      name: c.name ?? '',
      workflowName: c.workflowName ?? null,
      status: c.status ?? 'UNKNOWN',
      conclusion: c.conclusion ?? null,
      detailsUrl: c.detailsUrl || null,
      startedAt: timestamp(c.startedAt),
      completedAt: timestamp(c.completedAt),
    })) ?? [];

  return { checks, ciStatus: deriveCiStatusFromCheckRollup(rollup) };
}
