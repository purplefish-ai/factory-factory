import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CIStatus, PRState } from '@prisma-gen/client';
import type { PRWithFullDetails, ReviewAction } from '@/shared/github-types';
import { createLogger } from './logger.service';

const execFileAsync = promisify(execFile);
const logger = createLogger('github-cli');

/**
 * Execute async functions with limited concurrency, preserving order.
 */
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  // Start `limit` workers
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

export type GitHubCLIErrorType =
  | 'cli_not_installed'
  | 'auth_required'
  | 'pr_not_found'
  | 'network_error'
  | 'unknown';

export interface PRStatusFromGitHub {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergedAt: string | null;
  updatedAt: string;
  statusCheckRollup: Array<{ state: string }> | null;
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

/**
 * Service for interacting with GitHub via the `gh` CLI.
 * Uses the locally authenticated gh CLI instead of API tokens.
 */
class GitHubCLIService {
  /**
   * Classify an error from gh CLI execution.
   */
  private classifyError(error: unknown): GitHubCLIErrorType {
    const message = error instanceof Error ? error.message : String(error);
    const lowerMessage = message.toLowerCase();

    // Check for CLI not installed (ENOENT = file not found)
    if (lowerMessage.includes('enoent') || lowerMessage.includes('not found')) {
      return 'cli_not_installed';
    }

    // Check for auth issues
    if (
      lowerMessage.includes('authentication') ||
      lowerMessage.includes('not logged in') ||
      lowerMessage.includes('gh auth login')
    ) {
      return 'auth_required';
    }

    // Check for PR not found
    if (lowerMessage.includes('could not resolve') || lowerMessage.includes('not found')) {
      return 'pr_not_found';
    }

    // Check for network issues
    if (
      lowerMessage.includes('network') ||
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('connection')
    ) {
      return 'network_error';
    }

    return 'unknown';
  }

  /**
   * Check if gh CLI is installed and authenticated.
   */
  async checkHealth(): Promise<GitHubCLIHealthStatus> {
    // Check if gh is installed
    try {
      const { stdout: versionOutput } = await execFileAsync('gh', ['--version'], { timeout: 5000 });
      const versionMatch = versionOutput.match(/gh version ([\d.]+)/);
      const version = versionMatch?.[1];

      // Check if authenticated
      try {
        await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
        return { isInstalled: true, isAuthenticated: true, version };
      } catch {
        return {
          isInstalled: true,
          isAuthenticated: false,
          version,
          error: 'GitHub CLI is not authenticated. Run `gh auth login` to authenticate.',
          errorType: 'auth_required',
        };
      }
    } catch (error) {
      const errorType = this.classifyError(error);
      return {
        isInstalled: false,
        isAuthenticated: false,
        error:
          errorType === 'cli_not_installed'
            ? 'GitHub CLI (gh) is not installed. Install from https://cli.github.com/'
            : `Failed to check gh CLI: ${error instanceof Error ? error.message : String(error)}`,
        errorType,
      };
    }
  }

  /**
   * Extract PR info (owner, repo, number) from a GitHub PR URL.
   */
  extractPRInfo(prUrl: string): PRInfo | null {
    // Match URLs like:
    // https://github.com/owner/repo/pull/123
    // https://github.com/owner/repo/pull/123/files
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) {
      return null;
    }

    return {
      owner: match[1],
      repo: match[2],
      number: Number.parseInt(match[3], 10),
    };
  }

  /**
   * Get PR status from GitHub using the gh CLI.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: error classification logic
  async getPRStatus(prUrl: string): Promise<PRStatusFromGitHub | null> {
    const prInfo = this.extractPRInfo(prUrl);
    if (!prInfo) {
      logger.warn('Could not parse PR URL', { prUrl });
      return null;
    }

    try {
      // Use gh pr view with --json to get structured data
      // Using execFile with args array prevents shell injection
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr',
          'view',
          String(prInfo.number),
          '--repo',
          `${prInfo.owner}/${prInfo.repo}`,
          '--json',
          'number,state,isDraft,reviewDecision,mergedAt,updatedAt,statusCheckRollup',
        ],
        { timeout: 30_000 }
      );

      const data = JSON.parse(stdout);

      return {
        number: data.number,
        state: data.state,
        isDraft: data.isDraft,
        reviewDecision: data.reviewDecision || null,
        mergedAt: data.mergedAt || null,
        updatedAt: data.updatedAt,
        statusCheckRollup: data.statusCheckRollup || null,
      };
    } catch (error) {
      const errorType = this.classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log with appropriate level based on error type
      if (errorType === 'cli_not_installed' || errorType === 'auth_required') {
        logger.error('GitHub CLI configuration issue', {
          prUrl,
          errorType,
          error: errorMessage,
          hint:
            errorType === 'cli_not_installed'
              ? 'Install gh CLI from https://cli.github.com/'
              : 'Run `gh auth login` to authenticate',
        });
      } else if (errorType === 'pr_not_found') {
        logger.warn('PR not found', { prUrl, errorType });
      } else {
        logger.error('Failed to fetch PR status via gh CLI', {
          prUrl,
          errorType,
          error: errorMessage,
        });
      }
      return null;
    }
  }

  /**
   * Convert GitHub status check rollup to our CIStatus enum.
   */
  computeCIStatus(statusCheckRollup: Array<{ state: string }> | null): CIStatus {
    if (!statusCheckRollup || statusCheckRollup.length === 0) {
      return CIStatus.UNKNOWN;
    }

    // Check for any failures first
    const hasFailure = statusCheckRollup.some(
      (check) => check.state === 'FAILURE' || check.state === 'ERROR'
    );
    if (hasFailure) {
      return CIStatus.FAILURE;
    }

    // Check if any are still pending
    const hasPending = statusCheckRollup.some(
      (check) => check.state === 'PENDING' || check.state === 'EXPECTED' || check.state === 'QUEUED'
    );
    if (hasPending) {
      return CIStatus.PENDING;
    }

    // All checks passed
    const allSuccess = statusCheckRollup.every((check) => check.state === 'SUCCESS');
    if (allSuccess) {
      return CIStatus.SUCCESS;
    }

    // Default to unknown for any other state combinations
    return CIStatus.UNKNOWN;
  }

  /**
   * Convert GitHub PR status to our PRState enum.
   */
  computePRState(status: PRStatusFromGitHub): PRState {
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

  /**
   * Fetch PR status and convert to our PRState.
   * Returns null if PR cannot be fetched.
   */
  async fetchAndComputePRState(prUrl: string): Promise<{
    prState: PRState;
    prNumber: number;
    prReviewState: string | null;
    prCiStatus: CIStatus;
  } | null> {
    const status = await this.getPRStatus(prUrl);
    if (!status) {
      return null;
    }

    return {
      prState: this.computePRState(status),
      prNumber: status.number,
      prReviewState: status.reviewDecision,
      prCiStatus: this.computeCIStatus(status.statusCheckRollup),
    };
  }

  /**
   * List all PRs where the authenticated user is requested as a reviewer.
   * Fetches reviewDecision for each PR to show accurate status.
   */
  async listReviewRequests(): Promise<ReviewRequestedPR[]> {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'search',
        'prs',
        '--review-requested=@me',
        '--state=open',
        '--json',
        'number,title,url,repository,author,createdAt,isDraft',
      ],
      { timeout: 30_000 }
    );

    const basePRs = JSON.parse(stdout) as Omit<
      ReviewRequestedPR,
      'reviewDecision' | 'additions' | 'deletions' | 'changedFiles'
    >[];

    // Fetch reviewDecision and stats for each PR with limited concurrency to avoid rate limits
    const prsWithDetails = await mapWithConcurrencyLimit(
      basePRs,
      async (pr) => {
        try {
          const { stdout: prDetails } = await execFileAsync(
            'gh',
            [
              'pr',
              'view',
              String(pr.number),
              '--repo',
              pr.repository.nameWithOwner,
              '--json',
              'reviewDecision,additions,deletions,changedFiles',
            ],
            { timeout: 10_000 }
          );
          const details = JSON.parse(prDetails);
          return {
            ...pr,
            reviewDecision: details.reviewDecision || null,
            additions: details.additions ?? 0,
            deletions: details.deletions ?? 0,
            changedFiles: details.changedFiles ?? 0,
          };
        } catch {
          // If we can't fetch details, use defaults
          return { ...pr, reviewDecision: null, additions: 0, deletions: 0, changedFiles: 0 };
        }
      },
      5 // Limit to 5 concurrent requests to avoid GitHub rate limits
    );

    return prsWithDetails;
  }

  /**
   * Find a PR for a given branch in a repository.
   * Checks both open and merged PRs to handle workspaces where the PR was merged.
   * Returns the PR URL if found, null otherwise.
   */
  async findPRForBranch(
    owner: string,
    repo: string,
    branchName: string
  ): Promise<{ url: string; number: number } | null> {
    try {
      // First check for open PRs
      const { stdout: openStdout } = await execFileAsync(
        'gh',
        [
          'pr',
          'list',
          '--head',
          branchName,
          '--repo',
          `${owner}/${repo}`,
          '--json',
          'number,url',
          '--limit',
          '1',
        ],
        { timeout: 30_000 }
      );

      const openPrs = JSON.parse(openStdout) as Array<{ number: number; url: string }>;
      if (openPrs.length > 0) {
        return { url: openPrs[0].url, number: openPrs[0].number };
      }

      // If no open PR found, check for merged PRs
      const { stdout: mergedStdout } = await execFileAsync(
        'gh',
        [
          'pr',
          'list',
          '--head',
          branchName,
          '--repo',
          `${owner}/${repo}`,
          '--state',
          'merged',
          '--json',
          'number,url',
          '--limit',
          '1',
        ],
        { timeout: 30_000 }
      );

      const mergedPrs = JSON.parse(mergedStdout) as Array<{ number: number; url: string }>;
      if (mergedPrs.length > 0) {
        return { url: mergedPrs[0].url, number: mergedPrs[0].number };
      }

      return null;
    } catch (error) {
      const errorType = this.classifyError(error);
      if (errorType !== 'cli_not_installed' && errorType !== 'auth_required') {
        logger.debug('No PR found for branch', { owner, repo, branchName });
      }
      return null;
    }
  }

  /**
   * Approve a PR.
   */
  async approvePR(owner: string, repo: string, prNumber: number): Promise<void> {
    const args = ['pr', 'review', String(prNumber), '--repo', `${owner}/${repo}`, '--approve'];

    try {
      await execFileAsync('gh', args, { timeout: 30_000 });
      logger.info('PR approved successfully', { owner, repo, prNumber });
    } catch (error) {
      const errorType = this.classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to approve PR via gh CLI', {
        owner,
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to approve PR: ${errorMessage}`);
    }
  }

  /**
   * Get full PR details including reviews, comments, labels, and CI status.
   */
  async getPRFullDetails(repo: string, prNumber: number): Promise<PRWithFullDetails> {
    const fields = [
      'number',
      'title',
      'url',
      'author',
      'createdAt',
      'updatedAt',
      'isDraft',
      'state',
      'reviewDecision',
      'statusCheckRollup',
      'reviews',
      'comments',
      'labels',
      'additions',
      'deletions',
      'changedFiles',
      'headRefName',
      'baseRefName',
      'mergeStateStatus',
    ].join(',');

    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'view', String(prNumber), '--repo', repo, '--json', fields],
        { timeout: 30_000 }
      );

      const data = JSON.parse(stdout);

      // Extract repository info from the repo string
      const [, repoName] = repo.split('/');

      return {
        number: data.number,
        title: data.title,
        url: data.url,
        author: data.author,
        repository: {
          name: repoName,
          nameWithOwner: repo,
        },
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        isDraft: data.isDraft,
        state: data.state,
        reviewDecision: data.reviewDecision || null,
        statusCheckRollup: data.statusCheckRollup || null,
        reviews: data.reviews || [],
        comments: data.comments || [],
        labels: data.labels || [],
        additions: data.additions || 0,
        deletions: data.deletions || 0,
        changedFiles: data.changedFiles || 0,
        headRefName: data.headRefName || '',
        baseRefName: data.baseRefName || '',
        mergeStateStatus: data.mergeStateStatus || 'UNKNOWN',
      };
    } catch (error) {
      const errorType = this.classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to fetch PR details via gh CLI', {
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to fetch PR details: ${errorMessage}`);
    }
  }

  /**
   * Get the diff for a PR.
   */
  async getPRDiff(repo: string, prNumber: number): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'diff', String(prNumber), '--repo', repo],
        { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 } // 10MB buffer for large diffs
      );

      return stdout;
    } catch (error) {
      const errorType = this.classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to fetch PR diff via gh CLI', {
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to fetch PR diff: ${errorMessage}`);
    }
  }

  /**
   * Submit a review for a PR (approve, request changes, or comment).
   */
  async submitReview(
    repo: string,
    prNumber: number,
    action: ReviewAction,
    body?: string
  ): Promise<void> {
    const actionFlags: Record<ReviewAction, string> = {
      approve: '--approve',
      'request-changes': '--request-changes',
      comment: '--comment',
    };

    const args = ['pr', 'review', String(prNumber), '--repo', repo, actionFlags[action]];

    if (body && (action === 'request-changes' || action === 'comment')) {
      args.push('--body', body);
    }

    try {
      await execFileAsync('gh', args, { timeout: 30_000 });
      logger.info('PR review submitted successfully', { repo, prNumber, action });
    } catch (error) {
      const errorType = this.classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to submit PR review via gh CLI', {
        repo,
        prNumber,
        action,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to submit review: ${errorMessage}`);
    }
  }
}

export const githubCLIService = new GitHubCLIService();
