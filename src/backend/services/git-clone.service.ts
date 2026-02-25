import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from '@/backend/lib/file-helpers';
import { execCommand, gitCommand } from '@/backend/lib/shell';
import { createLogger } from './logger.service';

const logger = createLogger('git-clone');

export interface GithubRepo {
  owner: string;
  repo: string;
}

export type ExistingCloneStatus = 'valid_repo' | 'not_repo' | 'not_exists';

const GITHUB_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isValidGithubPathSegment(segment: string): boolean {
  return GITHUB_PATH_SEGMENT_PATTERN.test(segment);
}

/**
 * Parse a GitHub HTTPS URL into owner and repo.
 * Accepts: https://github.com/owner/repo or https://github.com/owner/repo.git
 */
export function parseGithubUrl(url: string): GithubRepo | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) {
    return null;
  }

  const owner = match[1] as string;
  const repo = match[2] as string;
  if (!(isValidGithubPathSegment(owner) && isValidGithubPathSegment(repo))) {
    return null;
  }

  return { owner, repo };
}

class GitCloneService {
  /**
   * Compute the clone destination path for a GitHub repo.
   */
  getClonePath(reposDir: string, owner: string, repo: string): string {
    return join(reposDir, owner, repo);
  }

  /**
   * Check if the clone destination already exists and whether it's a valid git repo.
   */
  async checkExistingClone(clonePath: string): Promise<ExistingCloneStatus> {
    if (!(await pathExists(clonePath))) {
      return 'not_exists';
    }

    const result = await gitCommand(['rev-parse', '--git-dir'], clonePath);
    if (result.code !== 0) {
      return 'not_repo';
    }

    const cdupResult = await gitCommand(['rev-parse', '--show-cdup'], clonePath);
    if (cdupResult.code !== 0) {
      return 'not_repo';
    }

    return cdupResult.stdout.trim() === '' ? 'valid_repo' : 'not_repo';
  }

  /**
   * Clone a GitHub repo to the specified destination.
   * Creates parent directories as needed.
   */
  async clone(
    url: string,
    destination: string
  ): Promise<{ success: boolean; output: string; error?: string }> {
    // Ensure parent directory exists
    const parentDir = join(destination, '..');
    await mkdir(parentDir, { recursive: true });

    logger.info('Cloning repository', { url, destination });

    const result = await execCommand('git', ['clone', '--progress', url, destination]);

    if (result.code !== 0) {
      const errorMsg = result.stderr || result.stdout || 'Clone failed with no output';
      logger.error('Clone failed', { url, destination, error: errorMsg });
      return { success: false, output: result.stderr, error: errorMsg };
    }

    logger.info('Clone completed', { url, destination });
    return { success: true, output: result.stderr }; // git clone writes progress to stderr
  }

  /**
   * Check if the GitHub CLI is authenticated.
   */
  async checkGithubAuth(): Promise<{
    authenticated: boolean;
    user?: string;
    error?: string;
  }> {
    try {
      const result = await execCommand('gh', ['auth', 'status']);
      // gh auth status writes to stderr on success
      const output = result.stderr || result.stdout;

      if (result.code === 0) {
        // Extract username from output like "Logged in to github.com account username"
        const userMatch = output.match(/account\s+(\S+)/);
        return {
          authenticated: true,
          user: userMatch?.[1],
        };
      }

      return { authenticated: false, error: output };
    } catch (error) {
      // gh CLI not installed or not found
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('ENOENT') || message.includes('not found')) {
        return {
          authenticated: false,
          error: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com',
        };
      }
      return { authenticated: false, error: message };
    }
  }
}

export const gitCloneService = new GitCloneService();
