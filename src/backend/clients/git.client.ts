import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

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

    const command = `git -C "${this.baseRepoPath}" worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`;

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
    } catch (error) {
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
}

let _gitClient: GitClient | null = null;

export const gitClient = new Proxy({} as GitClient, {
  get(target, prop) {
    if (!_gitClient) {
      _gitClient = new GitClient();
    }
    return _gitClient[prop as keyof GitClient];
  },
});
