export type GitHubCLIErrorType =
  | 'cli_not_installed'
  | 'auth_required'
  | 'pr_not_found'
  | 'network_error'
  | 'rate_limit'
  | 'unknown';

export interface PRStatusFromGitHub {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergedAt: string | null;
  updatedAt: string;
  statusCheckRollup: Array<{
    status?: string; // COMPLETED, QUEUED, IN_PROGRESS, etc.
    conclusion?: string; // SUCCESS, FAILURE, NEUTRAL, CANCELLED, SKIPPED, etc.
    state?: string; // Legacy format support
  }> | null;
}

export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
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
