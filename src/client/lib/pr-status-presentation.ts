/**
 * Human-readable labels and status tones for GitHub review, merge and check
 * states, so review surfaces never show raw API enums such as
 * `CHANGES_REQUESTED` or `BLOCKED`. Colors come from `status-tones.ts`.
 */

import { deriveCiStatusFromCheckRollup } from '@/shared/core';
import type {
  GitHubReview,
  GitHubStatusCheck,
  MergeStateStatus,
  ReviewDecision,
} from '@/shared/github-types';
import type { StatusPresentation } from './status-tones';

/** `TIMED_OUT` → `Timed out`. */
export function humanizeGitHubEnum(value: string): string {
  const words = value.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function getReviewDecisionPresentation(decision: ReviewDecision): StatusPresentation {
  switch (decision) {
    case 'APPROVED':
      return { tone: 'success', label: 'Approved' };
    case 'CHANGES_REQUESTED':
      return { tone: 'danger', label: 'Changes requested' };
    case 'REVIEW_REQUIRED':
      return { tone: 'attention', label: 'Review required' };
    default:
      return { tone: 'neutral', label: 'Pending' };
  }
}

export function getReviewStatePresentation(state: GitHubReview['state']): StatusPresentation {
  switch (state) {
    case 'APPROVED':
      return { tone: 'success', label: 'Approved' };
    case 'CHANGES_REQUESTED':
      return { tone: 'danger', label: 'Changes requested' };
    default:
      return { tone: 'neutral', label: humanizeGitHubEnum(state) };
  }
}

const MERGE_STATE_PRESENTATIONS: Record<MergeStateStatus, StatusPresentation> = {
  CLEAN: { tone: 'success', label: 'Ready to merge' },
  HAS_HOOKS: { tone: 'success', label: 'Ready to merge' },
  UNSTABLE: { tone: 'warning', label: 'Checks not passing' },
  BEHIND: { tone: 'warning', label: 'Behind base branch' },
  BLOCKED: { tone: 'attention', label: 'Blocked' },
  DIRTY: { tone: 'danger', label: 'Merge conflicts' },
  DRAFT: { tone: 'neutral', label: 'Draft' },
  UNKNOWN: { tone: 'neutral', label: 'Checking mergeability' },
};

export function getMergeStatePresentation(status: MergeStateStatus): StatusPresentation {
  return MERGE_STATE_PRESENTATIONS[status];
}

export type CheckOutcome = 'passed' | 'failed' | 'pending' | 'skipped' | 'unknown';

/** Classifies one check the same way the PR-level CI status does. */
export function getCheckOutcome(check: GitHubStatusCheck): CheckOutcome {
  if (check.status === 'COMPLETED' && check.conclusion === 'SKIPPED') {
    return 'skipped';
  }
  switch (deriveCiStatusFromCheckRollup([check])) {
    case 'SUCCESS':
      return 'passed';
    case 'FAILURE':
      return 'failed';
    case 'PENDING':
      return 'pending';
    default:
      return 'unknown';
  }
}

const CHECK_OUTCOME_TONES = {
  passed: 'success',
  failed: 'danger',
  pending: 'waiting',
  skipped: 'neutral',
  unknown: 'neutral',
} as const;

/** Tone plus the check's own conclusion or progress, humanized (e.g. "Timed out"). */
export function getCheckPresentation(check: GitHubStatusCheck): StatusPresentation {
  const outcome = getCheckOutcome(check);
  const raw = check.status === 'COMPLETED' ? (check.conclusion ?? 'COMPLETED') : check.status;
  const label = raw === 'IN_PROGRESS' ? 'Running' : humanizeGitHubEnum(raw);
  return { tone: CHECK_OUTCOME_TONES[outcome], label };
}
