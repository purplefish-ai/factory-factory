import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { gitCommandC } from '@/backend/lib/shell';

/**
 * Execute a command with proper argument separation (no shell injection).
 */
function execCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `Command exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Parse GitHub owner and repo from a git remote URL.
 * Supports both SSH and HTTPS formats:
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo
 * Returns null if the URL is not a GitHub URL or cannot be parsed.
 */
export function parseGitHubRemoteUrl(remoteUrl: string): { owner: string; repo: string } | null {
  // SSH format: git@github.com:owner/repo.git
  // Repo name: alphanumeric, hyphens, underscores, dots (no slashes)
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1] as string, repo: sshMatch[2] as string };
  }

  // HTTPS format: https://github.com/owner/repo.git or https://github.com/owner/repo
  // Repo name: alphanumeric, hyphens, underscores, dots (no slashes)
  const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1] as string, repo: httpsMatch[2] as string };
  }

  return null;
}

/**
 * Get GitHub owner/repo info from a git repository's remote.
 * Checks the 'origin' remote first.
 */
async function getGitHubInfoFromRepo(
  repoPath: string
): Promise<{ owner: string; repo: string } | null> {
  try {
    const result = await gitCommandC(repoPath, ['remote', 'get-url', 'origin']);
    if (result.code !== 0) {
      return null;
    }
    const remoteUrl = result.stdout.trim();
    return parseGitHubRemoteUrl(remoteUrl);
  } catch {
    return null;
  }
}

async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const result = await gitCommandC(repoPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
    const remoteHead = result.stdout.trim();
    if (result.code === 0 && remoteHead && remoteHead !== 'origin/HEAD') {
      const branch = remoteHead.replace(/^origin\//, '');
      if (branch && branch !== 'HEAD') {
        return branch;
      }
    }
  } catch {
    // Fall back to local HEAD when origin/HEAD cannot be read.
  }

  try {
    const result = await gitCommandC(repoPath, ['symbolic-ref', '--short', 'HEAD']);
    const branch = result.stdout.trim();
    if (result.code === 0 && branch) {
      return branch;
    }
  } catch {
    // Keep the historical default when git metadata is unavailable.
  }

  return 'main';
}

export async function inspectProjectRepository(repoPath: string): Promise<{
  githubOwner: string | null;
  githubRepo: string | null;
  defaultBranch: string;
}> {
  const githubInfo = await getGitHubInfoFromRepo(repoPath);
  const defaultBranch = await detectDefaultBranch(repoPath);
  return {
    githubOwner: githubInfo?.owner ?? null,
    githubRepo: githubInfo?.repo ?? null,
    defaultBranch,
  };
}

/** Validate readability and Git metadata without exposing shell interpolation. */
export async function validateRepositoryPath(
  repoPath: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Check if path exists and is readable
    await access(repoPath, constants.R_OK);

    // Check if it's a git repository (using spawn with args to prevent injection)
    await execCommand('git', ['-C', repoPath, 'rev-parse', '--git-dir']);

    return { valid: true };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('ENOENT')) {
        return { valid: false, error: 'Path does not exist' };
      }
      if (error.message.includes('EACCES')) {
        return { valid: false, error: 'Path is not accessible' };
      }
      if (error.message.includes('not a git repository')) {
        return { valid: false, error: 'Path is not a git repository' };
      }
      return { valid: false, error: error.message };
    }
    return { valid: false, error: 'Unknown error' };
  }
}
