import type { PRWithFullDetails } from '@/shared/github-types';

export type GitHubCLIErrorType =
  | 'cli_not_installed'
  | 'auth_required'
  | 'pr_not_found'
  | 'network_error'
  | 'rate_limit'
  | 'unknown';

export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
}

export interface OpenPullRequest {
  number: number;
  url: string;
  createdAt: string;
  headRefName: string;
}

export interface ReviewRequestedPR {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  author: { login: string };
  createdAt: string;
  isDraft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface GitHubCLIHealthStatus {
  isInstalled: boolean;
  isAuthenticated: boolean;
  version?: string;
  error?: string;
  errorType?: GitHubCLIErrorType;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  createdAt: string;
  author: { login: string };
}

export type PRStatusDetails = Pick<
  PRWithFullDetails,
  | 'number'
  | 'title'
  | 'url'
  | 'updatedAt'
  | 'isDraft'
  | 'state'
  | 'reviewDecision'
  | 'statusCheckRollup'
  | 'headRefOid'
  | 'headRefName'
  | 'baseRefName'
  | 'mergeStateStatus'
>;

export type PRReviewDetails = Pick<PRWithFullDetails, 'updatedAt' | 'reviews' | 'comments'>;
