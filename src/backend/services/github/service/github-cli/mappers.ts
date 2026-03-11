import type { z } from 'zod';
import { type CIStatus, deriveCiStatusFromCheckRollup, PRState } from '@/shared/core';
import type {
  GitHubComment,
  GitHubLabel,
  GitHubReview,
  GitHubStatusCheck,
} from '@/shared/github-types';
import type { fullPRDetailsSchema } from './schemas';
import type { PRStatusFromGitHub } from './types';

const CHECK_STATUS_VALUES = ['COMPLETED', 'IN_PROGRESS', 'PENDING', 'QUEUED'] as const;
const CHECK_CONCLUSION_VALUES = [
  'SUCCESS',
  'FAILURE',
  'SKIPPED',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'NEUTRAL',
] as const;
const REVIEW_STATE_VALUES = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'PENDING',
  'DISMISSED',
] as const;

function normalizeCheckStatus(status: string): GitHubStatusCheck['status'] {
  return (CHECK_STATUS_VALUES as readonly string[]).includes(status)
    ? (status as GitHubStatusCheck['status'])
    : 'PENDING';
}

function normalizeCheckConclusion(
  conclusion: string | null | undefined
): GitHubStatusCheck['conclusion'] {
  if (conclusion === null || conclusion === undefined) {
    return null;
  }
  return (CHECK_CONCLUSION_VALUES as readonly string[]).includes(conclusion)
    ? (conclusion as NonNullable<GitHubStatusCheck['conclusion']>)
    : null;
}

function normalizeStatusContextStatus(state: string): GitHubStatusCheck['status'] {
  if (state === 'PENDING' || state === 'EXPECTED') {
    return 'PENDING';
  }
  return 'COMPLETED';
}

function normalizeStatusContextConclusion(state: string): GitHubStatusCheck['conclusion'] {
  switch (state) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILURE':
    case 'ERROR':
      return 'FAILURE';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    case 'ACTION_REQUIRED':
      return 'ACTION_REQUIRED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'SKIPPED':
      return 'SKIPPED';
    case 'NEUTRAL':
      return 'NEUTRAL';
    default:
      return null;
  }
}

function normalizeReviewState(state: string): GitHubReview['state'] {
  return (REVIEW_STATE_VALUES as readonly string[]).includes(state)
    ? (state as GitHubReview['state'])
    : 'PENDING';
}

export function mapStatusChecks(
  checks: NonNullable<z.infer<typeof fullPRDetailsSchema>['statusCheckRollup']>
): GitHubStatusCheck[] {
  return checks.map((check) => {
    if ('context' in check) {
      return {
        __typename: 'StatusContext',
        name: check.context,
        status: normalizeStatusContextStatus(check.state),
        conclusion: normalizeStatusContextConclusion(check.state),
        detailsUrl: check.targetUrl ?? check.detailsUrl,
      };
    }

    return {
      __typename: check.__typename ?? 'CheckRun',
      name: check.name,
      status: normalizeCheckStatus(check.status),
      conclusion: normalizeCheckConclusion(check.conclusion),
      detailsUrl: check.detailsUrl,
    };
  });
}

export function mapReviews(
  reviews: z.infer<typeof fullPRDetailsSchema>['reviews']
): GitHubReview[] {
  return reviews.map((review) => ({
    id: review.id,
    author: review.author,
    state: normalizeReviewState(review.state),
    submittedAt: review.submittedAt,
    body: review.body,
  }));
}

export function mapComments(
  comments: z.infer<typeof fullPRDetailsSchema>['comments']
): GitHubComment[] {
  return comments.map((comment) => ({
    id: comment.id,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt ?? comment.createdAt,
    url: comment.url,
  }));
}

export function mapLabels(labels: z.infer<typeof fullPRDetailsSchema>['labels']): GitHubLabel[] {
  return labels.map((label) => ({
    name: label.name,
    color: label.color,
  }));
}

/**
 * Convert GitHub status check rollup to our CIStatus enum.
 * Handles both GitHub Check Run format (status + conclusion) and legacy format (state).
 */
export function computeCIStatus(
  statusCheckRollup: Array<{
    status?: string;
    conclusion?: string;
    state?: string;
  }> | null
): CIStatus {
  return deriveCiStatusFromCheckRollup(statusCheckRollup);
}

/**
 * Convert GitHub PR status to our PRState enum.
 */
export function computePRState(status: PRStatusFromGitHub): PRState {
  // Check if merged first
  if (status.mergedAt || status.state === 'MERGED') {
    return PRState.MERGED;
  }

  // Check if closed (but not merged)
  if (status.state === 'CLOSED') {
    return PRState.CLOSED;
  }

  // PR is open - check draft status and review state
  if (status.isDraft) {
    return PRState.DRAFT;
  }

  // Check review decision
  if (status.reviewDecision === 'APPROVED') {
    return PRState.APPROVED;
  }

  if (status.reviewDecision === 'CHANGES_REQUESTED') {
    return PRState.CHANGES_REQUESTED;
  }

  // Default to OPEN for open PRs without special review state
  return PRState.OPEN;
}
