import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PRState } from '@prisma-gen/client';
import type { PRWithFullDetails, ReviewAction } from '@/shared/github-types';
import { createLogger } from './logger.service';

const execFileAsync = promisify(execFile);
const logger = createLogger('github-cli');

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
          'number,state,isDraft,reviewDecision,mergedAt,updatedAt',
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
  async fetchAndComputePRState(
    prUrl: string
  ): Promise<{ prState: PRState; prNumber: number; prReviewState: string | null } | null> {
    const status = await this.getPRStatus(prUrl);
    if (!status) {
      return null;
    }

    return {
      prState: this.computePRState(status),
      prNumber: status.number,
      prReviewState: status.reviewDecision,
    };
  }

  /**
   * List all PRs where the authenticated user is requested as a reviewer.
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

    const data = JSON.parse(stdout);
    return data as ReviewRequestedPR[];
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
