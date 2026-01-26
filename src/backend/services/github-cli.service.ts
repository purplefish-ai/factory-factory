import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PRState } from '@prisma-gen/client';
import { createLogger } from './logger.service';

const execFileAsync = promisify(execFile);
const logger = createLogger('github-cli');

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

/**
 * Service for interacting with GitHub via the `gh` CLI.
 * Uses the locally authenticated gh CLI instead of API tokens.
 */
class GitHubCLIService {
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
      logger.error('Failed to fetch PR status via gh CLI', {
        prUrl,
        error: error instanceof Error ? error.message : String(error),
      });
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
}

export const githubCLIService = new GitHubCLIService();
