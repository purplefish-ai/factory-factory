import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@/backend/services/logger.service';
import type { PRWithFullDetails, ReviewAction } from '@/shared/github-types';
import { GH_MAX_BUFFER_BYTES, GH_TIMEOUT_MS } from './github-cli/constants';
import { classifyError, logGitHubCLIError } from './github-cli/errors';
import {
  computeCIStatus,
  computePRState,
  mapComments,
  mapLabels,
  mapReviews,
  mapStatusChecks,
} from './github-cli/mappers';
import {
  basePRSchema,
  fullPRDetailsSchema,
  issueSchema,
  prDetailsSchema,
  prListItemSchema,
  prStatusSchema,
  reviewCommentSchema,
} from './github-cli/schemas';
import type {
  GitHubCLIErrorType,
  GitHubCLIHealthStatus,
  GitHubIssue,
  PRInfo,
  PRStatusFromGitHub,
  ReviewRequestedPR,
} from './github-cli/types';
import { mapWithConcurrencyLimit, parseGhJson } from './github-cli/utils';

const execFileAsync = promisify(execFile);
const logger = createLogger('github-cli');

/**
 * Service for interacting with GitHub via the `gh` CLI.
 * Uses the locally authenticated gh CLI instead of API tokens.
 */
class GitHubCLIService {
  /**
   * Get the authenticated user's GitHub username.
   * Returns null if not authenticated or gh CLI is not available.
   */
  async getAuthenticatedUsername(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], {
        timeout: GH_TIMEOUT_MS.userLookup,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if gh CLI is installed and authenticated.
   */
  async checkHealth(): Promise<GitHubCLIHealthStatus> {
    try {
      const { stdout: versionOutput } = await execFileAsync('gh', ['--version'], {
        timeout: GH_TIMEOUT_MS.healthVersion,
      });
      const versionMatch = versionOutput.match(/gh version ([\d.]+)/);
      const version = versionMatch?.[1];

      try {
        await execFileAsync('gh', ['auth', 'status'], { timeout: GH_TIMEOUT_MS.healthAuth });
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
      const errorType = classifyError(error);
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
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) {
      return null;
    }

    return {
      owner: match[1] as string,
      repo: match[2] as string,
      number: Number.parseInt(match[3] as string, 10),
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
        { timeout: GH_TIMEOUT_MS.default }
      );

      return parseGhJson(prStatusSchema, stdout, 'getPRStatus');
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logGitHubCLIError(errorType, errorMessage, { prUrl });
      if (errorType === 'rate_limit') {
        throw error;
      }
      return null;
    }
  }

  computeCIStatus(statusCheckRollup: PRStatusFromGitHub['statusCheckRollup']) {
    return computeCIStatus(statusCheckRollup);
  }

  computePRState(status: PRStatusFromGitHub) {
    return computePRState(status);
  }

  /**
   * Fetch PR status and convert to our PRState.
   * Returns null if PR cannot be fetched.
   */
  async fetchAndComputePRState(prUrl: string): Promise<{
    prState: import('@prisma-gen/client').PRState;
    prNumber: number;
    prReviewState: string | null;
    prCiStatus: import('@prisma-gen/client').CIStatus;
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
      { timeout: GH_TIMEOUT_MS.default }
    );

    const basePRs = parseGhJson(basePRSchema.array(), stdout, 'listReviewRequests');

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
            { timeout: GH_TIMEOUT_MS.reviewDetails }
          );
          const details = parseGhJson(prDetailsSchema, prDetails, 'listReviewRequests:prDetails');
          return {
            ...pr,
            reviewDecision: details.reviewDecision,
            additions: details.additions ?? 0,
            deletions: details.deletions ?? 0,
            changedFiles: details.changedFiles ?? 0,
          };
        } catch {
          return { ...pr, reviewDecision: null, additions: 0, deletions: 0, changedFiles: 0 };
        }
      },
      5
    );

    return prsWithDetails;
  }

  /**
   * Find a PR for a given branch in a repository.
   * Only returns open PRs created after the workspace was created.
   * Returns the PR URL if found, null otherwise.
   */
  async findPRForBranch(
    owner: string,
    repo: string,
    branchName: string,
    workspaceCreatedAt?: Date
  ): Promise<{ url: string; number: number } | null> {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr',
          'list',
          '--head',
          branchName,
          '--repo',
          `${owner}/${repo}`,
          '--state',
          'open',
          '--json',
          'number,url,state,createdAt',
          '--limit',
          '10',
        ],
        { timeout: GH_TIMEOUT_MS.default }
      );

      const prs = parseGhJson(prListItemSchema.array(), stdout, 'findPRForBranch');
      if (prs.length === 0) {
        return null;
      }

      // Filter out PRs created before the workspace (prevents branch name collisions)
      const filteredPRs = workspaceCreatedAt
        ? prs.filter((pr) => new Date(pr.createdAt) >= workspaceCreatedAt)
        : prs;

      const pr = filteredPRs[0];
      if (!pr) {
        return null;
      }
      return { url: pr.url, number: pr.number };
    } catch (error) {
      const errorType = classifyError(error);
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
      await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS.default });
      logger.info('PR approved successfully', { owner, repo, prNumber });
    } catch (error) {
      const errorType = classifyError(error);
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
        { timeout: GH_TIMEOUT_MS.default }
      );

      const data = parseGhJson(fullPRDetailsSchema, stdout, 'getPRFullDetails');

      const [, repoName] = repo.split('/') as [string, string];

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
        reviewDecision: data.reviewDecision,
        statusCheckRollup: data.statusCheckRollup ? mapStatusChecks(data.statusCheckRollup) : null,
        reviews: mapReviews(data.reviews),
        comments: mapComments(data.comments),
        labels: mapLabels(data.labels),
        additions: data.additions || 0,
        deletions: data.deletions || 0,
        changedFiles: data.changedFiles || 0,
        headRefName: data.headRefName || '',
        baseRefName: data.baseRefName || '',
        mergeStateStatus: data.mergeStateStatus || 'UNKNOWN',
      };
    } catch (error) {
      const errorType = classifyError(error);
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
        { timeout: GH_TIMEOUT_MS.diff, maxBuffer: GH_MAX_BUFFER_BYTES.diff }
      );

      return stdout;
    } catch (error) {
      const errorType = classifyError(error);
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
      await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS.default });
      logger.info('PR review submitted successfully', { repo, prNumber, action });
    } catch (error) {
      const errorType = classifyError(error);
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

  /**
   * List open issues for a repository.
   * Fetches fresh on every call (no caching).
   * @param assignee - Filter by assignee. Use '@me' for issues assigned to the authenticated user.
   */
  async listIssues(
    owner: string,
    repo: string,
    options: { limit?: number; assignee?: string } = {}
  ): Promise<GitHubIssue[]> {
    const { limit = 50, assignee } = options;
    try {
      const args = [
        'issue',
        'list',
        '--repo',
        `${owner}/${repo}`,
        '--state',
        'open',
        '--json',
        'number,title,body,url,state,createdAt,author',
        '--limit',
        String(limit),
      ];

      if (assignee) {
        args.push('--assignee', assignee);
      }

      const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS.default });

      return parseGhJson(issueSchema.array(), stdout, 'listIssues');
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to list issues via gh CLI', {
        owner,
        repo,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to list issues: ${errorMessage}`);
    }
  }

  /**
   * Get review comments (line-level comments on code) for a PR.
   * These are different from regular PR comments - they're attached to specific lines in the diff.
   */
  async getReviewComments(
    repo: string,
    prNumber: number
  ): Promise<
    Array<{
      id: number;
      author: { login: string };
      body: string;
      path: string;
      line: number | null;
      createdAt: string;
      updatedAt: string;
      url: string;
    }>
  > {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', `repos/${repo}/pulls/${prNumber}/comments`, '--paginate'],
        { timeout: GH_TIMEOUT_MS.default }
      );

      if (!stdout.trim()) {
        return [];
      }

      const comments = parseGhJson(reviewCommentSchema.array(), stdout, 'getReviewComments');
      return comments.map((comment) => ({
        id: comment.id,
        author: { login: comment.user.login },
        body: comment.body,
        path: comment.path,
        line: comment.line,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        url: comment.html_url,
      }));
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to fetch PR review comments via gh CLI', {
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to fetch PR review comments: ${errorMessage}`);
    }
  }

  /**
   * Add a comment to a PR.
   */
  async addPRComment(repo: string, prNumber: number, body: string): Promise<void> {
    try {
      await execFileAsync(
        'gh',
        ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body],
        {
          timeout: GH_TIMEOUT_MS.default,
        }
      );
      logger.info('PR comment added successfully', { repo, prNumber });
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to add PR comment via gh CLI', {
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to add PR comment: ${errorMessage}`);
    }
  }

  /**
   * Add a comment to a GitHub issue.
   */
  async addIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<void> {
    try {
      await execFileAsync(
        'gh',
        ['issue', 'comment', String(issueNumber), '--repo', `${owner}/${repo}`, '--body', body],
        { timeout: GH_TIMEOUT_MS.default }
      );
      logger.info('Issue comment added successfully', { owner, repo, issueNumber });
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to add issue comment via gh CLI', {
        owner,
        repo,
        issueNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to add issue comment: ${errorMessage}`);
    }
  }

  /**
   * Get a single GitHub issue by number.
   */
  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue | null> {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'issue',
          'view',
          String(issueNumber),
          '--repo',
          `${owner}/${repo}`,
          '--json',
          'number,title,body,url,state,createdAt,author',
        ],
        { timeout: GH_TIMEOUT_MS.default }
      );

      return parseGhJson(issueSchema, stdout, 'getIssue');
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to get issue via gh CLI', {
        owner,
        repo,
        issueNumber,
        errorType,
        error: errorMessage,
      });

      return null;
    }
  }

  /**
   * Close a GitHub issue.
   */
  async closeIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
    try {
      await execFileAsync(
        'gh',
        ['issue', 'close', String(issueNumber), '--repo', `${owner}/${repo}`],
        { timeout: GH_TIMEOUT_MS.default }
      );
      logger.info('Issue closed successfully', { owner, repo, issueNumber });
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to close issue via gh CLI', {
        owner,
        repo,
        issueNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to close issue: ${errorMessage}`);
    }
  }
}

export type {
  GitHubCLIErrorType,
  GitHubCLIHealthStatus,
  GitHubIssue,
  PRInfo,
  PRStatusFromGitHub,
  ReviewRequestedPR,
};

export const githubCLIService = new GitHubCLIService();
