import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TRPCError } from '@trpc/server';
import { GitClientFactory } from '../clients/git.client';
import { pathExists } from '../lib/file-helpers';
import { getWorkspaceGitStats } from '../lib/git-helpers';
import { gitCommand } from '../lib/shell';

export type WorkspaceGitStats = Awaited<ReturnType<typeof getWorkspaceGitStats>>;

interface ProjectPaths {
  repoPath: string;
  worktreeBasePath: string;
}

class GitOpsService {
  private normalizeBranchName(branchName: string): string {
    if (branchName.startsWith('origin/')) {
      return branchName.slice('origin/'.length);
    }
    if (branchName.startsWith('refs/heads/')) {
      return branchName.slice('refs/heads/'.length);
    }
    return branchName;
  }

  getWorkspaceGitStats(worktreePath: string, defaultBranch: string): Promise<WorkspaceGitStats> {
    return getWorkspaceGitStats(worktreePath, defaultBranch);
  }

  /**
   * Check if a path is a valid git repository (worktree or regular repo).
   * Returns true if git commands can be run in this directory.
   */
  async isValidGitRepo(worktreePath: string): Promise<boolean> {
    const result = await gitCommand(['rev-parse', '--git-dir'], worktreePath);
    return result.code === 0;
  }

  async commitIfNeeded(
    worktreePath: string,
    workspaceName: string,
    commitUncommitted: boolean
  ): Promise<void> {
    // Check if this is a valid git repo first - if not, skip commit
    // This can happen if the worktree was corrupted or the .git file was removed
    const isValid = await this.isValidGitRepo(worktreePath);
    if (!isValid) {
      return;
    }

    const statusResult = await gitCommand(['status', '--porcelain'], worktreePath);
    if (statusResult.code !== 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Git status failed: ${statusResult.stderr || statusResult.stdout}`,
      });
    }

    if (statusResult.stdout.trim().length === 0) {
      return;
    }

    if (!commitUncommitted) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Workspace has uncommitted changes. Enable commit-before-archive to proceed.',
      });
    }

    const addResult = await gitCommand(['add', '-A'], worktreePath);
    if (addResult.code !== 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Git add failed: ${addResult.stderr || addResult.stdout}`,
      });
    }

    const commitMessage = `Archive workspace ${workspaceName}`;
    const commitResult = await gitCommand(
      ['commit', '-m', commitMessage, '--no-verify'],
      worktreePath
    );
    if (commitResult.code !== 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Git commit failed: ${commitResult.stderr || commitResult.stdout}`,
      });
    }
  }

  async removeWorktree(worktreePath: string, project: ProjectPaths): Promise<void> {
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });
    const worktreeName = path.basename(worktreePath);

    const registeredWorktree = await gitClient.checkWorktreeExists(worktreeName);
    if (registeredWorktree) {
      await gitClient.deleteWorktree(worktreeName);
      return;
    }

    if (await pathExists(worktreePath)) {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  }

  async ensureBaseBranchExists(
    project: ProjectPaths,
    baseBranch: string,
    defaultBranch: string
  ): Promise<void> {
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    const normalizedBranch = this.normalizeBranchName(baseBranch);

    const branchExists = await gitClient.branchExists(normalizedBranch);
    if (branchExists) {
      return;
    }

    const remoteBranchExists = await gitClient.branchExists(`origin/${normalizedBranch}`);
    if (!remoteBranchExists) {
      throw new Error(
        `Branch '${baseBranch}' does not exist. Please specify an existing branch or leave empty to use the default branch '${defaultBranch}'.`
      );
    }
  }

  async createWorktree(
    project: ProjectPaths,
    worktreeName: string,
    baseBranch: string,
    options: { branchPrefix?: string; workspaceName: string }
  ): Promise<{ worktreePath: string; branchName: string }> {
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    const worktreeInfo = await gitClient.createWorktree(worktreeName, baseBranch, options);
    const worktreePath = gitClient.getWorktreePath(worktreeName);

    return { worktreePath, branchName: worktreeInfo.branchName };
  }

  async createWorktreeFromExistingBranch(
    project: ProjectPaths,
    worktreeName: string,
    branchRef: string
  ): Promise<{ worktreePath: string; branchName: string }> {
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    const worktreeInfo = await gitClient.createWorktreeFromExistingBranch(worktreeName, branchRef);
    const worktreePath = gitClient.getWorktreePath(worktreeName);

    return { worktreePath, branchName: worktreeInfo.branchName };
  }

  async isBranchCheckedOut(project: ProjectPaths, branchName: string): Promise<boolean> {
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    const normalizedBranch = this.normalizeBranchName(branchName);
    const worktrees = await gitClient.listWorktreesWithBranches();
    const worktreeBasePath = path.resolve(project.worktreeBasePath);
    const basePrefix = `${worktreeBasePath}${path.sep}`;
    const repoPath = path.resolve(project.repoPath);

    return worktrees.some(
      (worktree) =>
        worktree.branchName &&
        this.normalizeBranchName(worktree.branchName) === normalizedBranch &&
        path.resolve(worktree.path).startsWith(basePrefix) &&
        path.resolve(worktree.path) !== repoPath
    );
  }
}

export const gitOpsService = new GitOpsService();
