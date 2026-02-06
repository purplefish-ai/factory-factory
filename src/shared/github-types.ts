/**
 * GitHub Types for PR Review Dashboard
 *
 * TypeScript interfaces for GitHub API data structures used in the PR review dashboard.
 */

export interface GitHubAuthor {
  login: string;
  name?: string;
}

export interface GitHubRepository {
  name: string;
  nameWithOwner: string;
}

export interface GitHubStatusCheck {
  __typename: 'CheckRun' | 'StatusContext';
  name: string;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'PENDING' | 'QUEUED';
  conclusion:
    | 'SUCCESS'
    | 'FAILURE'
    | 'SKIPPED'
    | 'CANCELLED'
    | 'TIMED_OUT'
    | 'ACTION_REQUIRED'
    | null;
  detailsUrl?: string;
}

export interface GitHubReview {
  id: string;
  author: { login: string };
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED';
  submittedAt: string;
  body?: string;
}

export interface GitHubComment {
  id: string;
  author: { login: string };
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface GitHubLabel {
  name: string;
  color: string;
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export type MergeStateStatus =
  | 'BEHIND'
  | 'BLOCKED'
  | 'CLEAN'
  | 'DIRTY'
  | 'HAS_HOOKS'
  | 'UNKNOWN'
  | 'UNSTABLE';

export interface PRWithFullDetails {
  number: number;
  title: string;
  url: string;
  author: GitHubAuthor;
  repository: GitHubRepository;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  reviewDecision: ReviewDecision;
  statusCheckRollup: GitHubStatusCheck[] | null;
  reviews: GitHubReview[];
  comments: GitHubComment[];
  labels: GitHubLabel[];
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  mergeStateStatus: MergeStateStatus;
}

export type ReviewAction = 'approve' | 'request-changes' | 'comment';

export interface SubmitReviewParams {
  repo: string;
  number: number;
  action: ReviewAction;
  body?: string;
}
