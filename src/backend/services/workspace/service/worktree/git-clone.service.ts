import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from '@/backend/lib/file-helpers';
import { execCommand, gitCommand } from '@/backend/lib/shell';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';

export { type GithubRepo, parseGithubUrl } from '@/shared/github-url';

const logger = createLogger('git-clone');
const GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export type ExistingCloneStatus = 'valid_repo' | 'not_repo' | 'not_exists';

interface CloneDestination {
  path: string;
  status: ExistingCloneStatus;
}

async function findCaseInsensitiveEntries(directory: string, name: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((entry) => entry.toLowerCase() === name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return [];
    }
    throw error;
  }
}

class GitCloneService {
  /**
   * Reuse existing clone paths regardless of GitHub URL casing. New clones use
   * lowercase owner/repo paths; existing directories are never renamed.
   */
  async getClonePath(reposDir: string, owner: string, repo: string): Promise<CloneDestination> {
    const canonicalPath = join(reposDir, owner.toLowerCase(), repo.toLowerCase());
    const candidates: string[] = [];
    for (const existingOwner of await findCaseInsensitiveEntries(reposDir, owner.toLowerCase())) {
      const ownerPath = join(reposDir, existingOwner);
      for (const existingRepo of await findCaseInsensitiveEntries(ownerPath, repo.toLowerCase())) {
        candidates.push(join(ownerPath, existingRepo));
      }
    }

    // Stable choice even if older imports already created multiple case variants.
    // Prefer the canonical clone, then other valid repositories over non-repos.
    candidates.sort();
    if (candidates.includes(canonicalPath)) {
      candidates.splice(candidates.indexOf(canonicalPath), 1);
      candidates.unshift(canonicalPath);
    }
    let firstCandidate: CloneDestination | undefined;
    for (const candidate of candidates) {
      const destination = { path: candidate, status: await this.checkExistingClone(candidate) };
      if (destination.status === 'valid_repo') {
        return destination;
      }
      firstCandidate ??= destination;
    }
    // Keep the caller's non-repository guard and reuse the selected path's status.
    return (
      firstCandidate ?? {
        path: canonicalPath,
        status: await this.checkExistingClone(canonicalPath),
      }
    );
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
   * Accepts both HTTPS and SSH URLs (git handles both formats).
   */
  async clone(
    url: string,
    destination: string
  ): Promise<{ success: boolean; output: string; error?: string }> {
    // Ensure parent directory exists
    const parentDir = join(destination, '..');
    await mkdir(parentDir, { recursive: true });
    const destinationExistedBeforeClone = await pathExists(destination);

    logger.info('Cloning repository', { url, destination });

    const result = await execCommand('git', ['clone', '--progress', url, destination], {
      env: {
        ...configService.getChildProcessEnv(),
        GCM_INTERACTIVE: 'never',
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      },
      timeout: GIT_CLONE_TIMEOUT_MS,
    });

    if (result.code !== 0) {
      if (!destinationExistedBeforeClone && (await pathExists(destination))) {
        await rm(destination, { recursive: true, force: true });
      }

      const errorMsg = result.timedOut
        ? `Clone timed out after ${Math.round(GIT_CLONE_TIMEOUT_MS / 1000)} seconds`
        : result.stderr || result.stdout || 'Clone failed with no output';
      logger.error('Clone failed', { url, destination, error: errorMsg });
      return { success: false, output: result.stderr, error: errorMsg };
    }

    logger.info('Clone completed', { url, destination });
    return { success: true, output: result.stderr }; // git clone writes progress to stderr
  }
}

export const gitCloneService = new GitCloneService();
