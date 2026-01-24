import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitCommand, gitCommandC } from '../lib/shell.js';

export interface GitWorktreeInfo {
  name: string;
  path: string;
  branchName: string;
}

export interface GitClientConfig {
  baseRepoPath: string;
  worktreeBase: string;
}

export class GitClient {
  private baseRepoPath: string;
  private worktreeBase: string;

  constructor(config: GitClientConfig) {
    if (!config.baseRepoPath) {
      throw new Error('baseRepoPath is required');
    }
    if (!config.worktreeBase) {
      throw new Error('worktreeBase is required');
    }

    this.baseRepoPath = config.baseRepoPath;
    this.worktreeBase = config.worktreeBase;
  }

  async createWorktree(name: string, baseBranch = 'main'): Promise<GitWorktreeInfo> {
    const worktreePath = this.getWorktreePath(name);
    const branchName = `factoryfactory/${name}`;

    await fs.mkdir(this.worktreeBase, { recursive: true });

    // First, check if the branch already exists
    const branchExists = await this.branchExists(branchName);

    // Use spawn with array args (safe - no shell interpretation)
    const args = branchExists
      ? ['worktree', 'add', worktreePath, branchName]
      : ['worktree', 'add', '-b', branchName, worktreePath, baseBranch];

    try {
      await gitCommandC(this.baseRepoPath, args);
      return {
        name,
        path: worktreePath,
        branchName,
      };
    } catch (error) {
      throw new Error(
        `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if a branch exists in the repository
   */
  async branchExists(branchName: string): Promise<boolean> {
    try {
      await gitCommandC(this.baseRepoPath, ['rev-parse', '--verify', branchName]);
      return true;
    } catch {
      return false;
    }
  }

  async deleteWorktree(name: string): Promise<void> {
    const worktreePath = this.getWorktreePath(name);

    try {
      await gitCommandC(this.baseRepoPath, ['worktree', 'remove', worktreePath, '--force']);
    } catch (error) {
      throw new Error(
        `Failed to delete worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getWorktreePath(name: string): string {
    return path.join(this.worktreeBase, name);
  }

  getBranchName(worktreeName: string): string {
    return `factoryfactory/${worktreeName}`;
  }

  async checkWorktreeExists(name: string): Promise<boolean> {
    const worktreePath = this.getWorktreePath(name);

    try {
      const { stdout } = await gitCommandC(this.baseRepoPath, ['worktree', 'list']);
      return stdout.includes(worktreePath);
    } catch {
      return false;
    }
  }

  async listWorktrees(): Promise<string[]> {
    try {
      const { stdout } = await gitCommandC(this.baseRepoPath, ['worktree', 'list', '--porcelain']);
      const worktrees: string[] = [];
      const lines = stdout.split('\n');

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          const worktreePath = line.substring('worktree '.length);
          if (worktreePath.startsWith(this.worktreeBase)) {
            const name = path.basename(worktreePath);
            worktrees.push(name);
          }
        }
      }

      return worktrees;
    } catch (error) {
      throw new Error(
        `Failed to list worktrees: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Merge a branch into another branch within a worktree
   * Used by supervisor to merge worker branches into epic branch
   */
  async mergeBranch(
    worktreePath: string,
    sourceBranch: string,
    commitMessage?: string
  ): Promise<{ success: boolean; mergeCommit: string }> {
    try {
      // Merge the source branch into the current branch using spawn (safe - no shell)
      const mergeArgs = commitMessage
        ? ['merge', sourceBranch, '-m', commitMessage]
        : ['merge', sourceBranch];

      await gitCommand(mergeArgs, worktreePath);

      // Get the merge commit SHA
      const { stdout: commitSha } = await gitCommand(['rev-parse', 'HEAD'], worktreePath);

      return {
        success: true,
        mergeCommit: commitSha.trim(),
      };
    } catch (error) {
      throw new Error(
        `Failed to merge branch ${sourceBranch}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Push a branch to origin
   * Used by supervisor to push epic branch after merging
   */
  async pushBranch(worktreePath: string, branchName?: string): Promise<void> {
    try {
      const branch = branchName || 'HEAD';
      await gitCommand(['push', 'origin', branch], worktreePath);
    } catch (error) {
      throw new Error(
        `Failed to push branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Push a branch to origin, setting upstream if needed
   */
  async pushBranchWithUpstream(worktreePath: string): Promise<void> {
    try {
      await gitCommand(['push', '-u', 'origin', 'HEAD'], worktreePath);
    } catch (error) {
      throw new Error(
        `Failed to push branch with upstream: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Fetch latest from origin
   */
  async fetch(worktreePath: string): Promise<void> {
    try {
      await gitCommand(['fetch', 'origin'], worktreePath);
    } catch (error) {
      throw new Error(`Failed to fetch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(worktreePath: string): Promise<string> {
    try {
      const { stdout } = await gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
      return stdout.trim();
    } catch (error) {
      throw new Error(
        `Failed to get current branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the latest commit message
   */
  async getLatestCommitMessage(worktreePath: string): Promise<string> {
    try {
      const { stdout } = await gitCommand(['log', '-1', '--format=%s'], worktreePath);
      return stdout.trim();
    } catch (error) {
      throw new Error(
        `Failed to get latest commit message: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Factory for creating project-specific GitClient instances.
 * Caches instances by repo+worktree path combination.
 */
export class GitClientFactory {
  private static instances = new Map<string, GitClient>();

  /**
   * Get or create a GitClient for a specific project.
   */
  static forProject(project: { repoPath: string; worktreeBasePath: string }): GitClient {
    const key = `${project.repoPath}:${project.worktreeBasePath}`;
    const existing = GitClientFactory.instances.get(key);
    if (existing) {
      return existing;
    }
    const client = new GitClient({
      baseRepoPath: project.repoPath,
      worktreeBase: project.worktreeBasePath,
    });
    GitClientFactory.instances.set(key, client);
    return client;
  }

  /**
   * Remove a cached GitClient for a project.
   * Call this when a project is deleted or its paths change.
   */
  static removeProject(project: { repoPath: string; worktreeBasePath: string }): boolean {
    const key = `${project.repoPath}:${project.worktreeBasePath}`;
    return GitClientFactory.instances.delete(key);
  }

  /**
   * Clear all cached instances. Useful for testing.
   */
  static clearCache(): void {
    GitClientFactory.instances.clear();
  }

  /**
   * Get the number of cached instances.
   */
  static get cacheSize(): number {
    return GitClientFactory.instances.size;
  }
}
