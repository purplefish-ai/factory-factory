import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitClientFactory } from '@/backend/clients/git.client';
import { ApplicationError } from '@/backend/lib/application-error';
import { pathExists } from '@/backend/lib/file-helpers';
import { gitCommand } from '@/backend/lib/shell';
import {
  getStats,
  type WorkspaceGitStats,
  workspaceGitStateService,
} from '@/backend/services/workspace-git-state.service';

export type { WorkspaceGitStats };

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

  async getWorkspaceGitStats(
    worktreePath: string,
    defaultBranch: string
  ): Promise<WorkspaceGitStats | null> {
    const snapshot = await workspaceGitStateService.getSnapshot({ worktreePath, defaultBranch });
    return getStats(snapshot);
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
      throw new ApplicationError('INTERNAL_ERROR', 'Git status failed', {
        cause: statusResult,
      });
    }

    if (statusResult.stdout.trim().length === 0) {
      return;
    }

    if (!commitUncommitted) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Workspace has uncommitted changes. Enable commit-before-archive to proceed.'
      );
    }

    try {
      const addResult = await gitCommand(['add', '-A'], worktreePath);
      if (addResult.code !== 0) {
        throw new ApplicationError('INTERNAL_ERROR', 'Git add failed', { cause: addResult });
      }

      const commitMessage = `Archive workspace ${workspaceName}`;
      const commitResult = await gitCommand(
        ['commit', '-m', commitMessage, '--no-verify'],
        worktreePath
      );
      if (commitResult.code !== 0) {
        throw new ApplicationError('INTERNAL_ERROR', 'Git commit failed', {
          cause: commitResult,
        });
      }
    } finally {
      workspaceGitStateService.invalidate(worktreePath);
    }
  }

  async removeWorktree(worktreePath: string, project: ProjectPaths): Promise<void> {
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });
    const worktreeName = path.basename(worktreePath);
    const expectedWorktreePath = path.resolve(worktreePath);
    const configuredWorktreePath = path.resolve(gitClient.getWorktreePath(worktreeName));

    if (expectedWorktreePath !== configuredWorktreePath) {
      throw new Error('Refusing to remove worktree because requested path does not match project');
    }

    const registeredWorktree = (await gitClient.listWorktreesWithBranches()).find(
      (entry) => path.resolve(entry.path) === expectedWorktreePath
    );
    if (registeredWorktree) {
      try {
        await gitClient.deleteWorktree(worktreeName);
      } catch (error) {
        workspaceGitStateService.invalidate(worktreePath);
        throw error;
      }
      workspaceGitStateService.remove(worktreePath);
      return;
    }

    if (await pathExists(worktreePath)) {
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
      } catch (error) {
        workspaceGitStateService.invalidate(worktreePath);
        throw error;
      }
    }
    workspaceGitStateService.remove(worktreePath);
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

    // Check if this is a blank repository (no commits yet)
    const isBlank = await gitClient.isBlankRepository();
    if (isBlank) {
      // Skip validation for blank repositories - the worktree creation will handle initialization
      return;
    }

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

    const worktreePath = gitClient.getWorktreePath(worktreeName);
    try {
      const worktreeInfo = await gitClient.createWorktree(worktreeName, baseBranch, options);
      return { worktreePath, branchName: worktreeInfo.branchName };
    } finally {
      workspaceGitStateService.invalidate(worktreePath);
    }
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

    const worktreePath = gitClient.getWorktreePath(worktreeName);
    try {
      const worktreeInfo = await gitClient.createWorktreeFromExistingBranch(
        worktreeName,
        branchRef
      );
      return { worktreePath, branchName: worktreeInfo.branchName };
    } finally {
      workspaceGitStateService.invalidate(worktreePath);
    }
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
