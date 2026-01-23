import { exec } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface GitWorktreeInfo {
  name: string;
  path: string;
  branchName: string;
}

export class GitClient {
  private baseRepoPath: string;
  private worktreeBase: string;

  constructor() {
    const baseRepoPath = process.env.GIT_BASE_REPO_PATH;
    const worktreeBase = process.env.GIT_WORKTREE_BASE;

    if (!baseRepoPath) {
      throw new Error('GIT_BASE_REPO_PATH environment variable is not set');
    }
    if (!worktreeBase) {
      throw new Error('GIT_WORKTREE_BASE environment variable is not set');
    }

    this.baseRepoPath = baseRepoPath;
    this.worktreeBase = worktreeBase;
  }

  async createWorktree(name: string, baseBranch = 'main'): Promise<GitWorktreeInfo> {
    const worktreePath = this.getWorktreePath(name);
    const branchName = `factoryfactory/${name}`;

    await fs.mkdir(this.worktreeBase, { recursive: true });

    // First, check if the branch already exists
    const branchExists = await this.branchExists(branchName);

    // Use different commands based on whether branch exists
    const command = branchExists
      ? `git -C "${this.baseRepoPath}" worktree add "${worktreePath}" "${branchName}"`
      : `git -C "${this.baseRepoPath}" worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`;

    try {
      await execAsync(command);
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
      await execAsync(`git -C "${this.baseRepoPath}" rev-parse --verify "${branchName}"`);
      return true;
    } catch {
      return false;
    }
  }

  async deleteWorktree(name: string): Promise<void> {
    const worktreePath = this.getWorktreePath(name);

    const removeCommand = `git -C "${this.baseRepoPath}" worktree remove "${worktreePath}" --force`;

    try {
      await execAsync(removeCommand);
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
      const { stdout } = await execAsync(`git -C "${this.baseRepoPath}" worktree list`);
      return stdout.includes(worktreePath);
    } catch {
      return false;
    }
  }

  async listWorktrees(): Promise<string[]> {
    try {
      const { stdout } = await execAsync(`git -C "${this.baseRepoPath}" worktree list --porcelain`);
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
      // Merge the source branch into the current branch
      const mergeCommand = commitMessage
        ? `git -C "${worktreePath}" merge "${sourceBranch}" -m "${commitMessage.replace(/"/g, '\\"')}"`
        : `git -C "${worktreePath}" merge "${sourceBranch}"`;

      await execAsync(mergeCommand);

      // Get the merge commit SHA
      const { stdout: commitSha } = await execAsync(`git -C "${worktreePath}" rev-parse HEAD`);

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
      await execAsync(`git -C "${worktreePath}" push origin ${branch}`);
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
      await execAsync(`git -C "${worktreePath}" push -u origin HEAD`);
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
      await execAsync(`git -C "${worktreePath}" fetch origin`);
    } catch (error) {
      throw new Error(`Failed to fetch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(worktreePath: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`git -C "${worktreePath}" rev-parse --abbrev-ref HEAD`);
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
      const { stdout } = await execAsync(`git -C "${worktreePath}" log -1 --format=%s`);
      return stdout.trim();
    } catch (error) {
      throw new Error(
        `Failed to get latest commit message: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

let _gitClient: GitClient | null = null;

export const gitClient = new Proxy({} as GitClient, {
  get(_target, prop) {
    if (!_gitClient) {
      _gitClient = new GitClient();
    }
    return _gitClient[prop as keyof GitClient];
  },
});
