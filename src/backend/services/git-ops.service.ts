import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TRPCError } from '@trpc/server';
import { GitClientFactory } from '../clients/git.client';
import { getWorkspaceGitStats } from '../lib/git-helpers';
import { gitCommand } from '../lib/shell';

export type WorkspaceGitStats = Awaited<ReturnType<typeof getWorkspaceGitStats>>;

interface ProjectPaths {
  repoPath: string;
  worktreeBasePath: string;
}

function pathExists(targetPath: string): Promise<boolean> {
  return fs
    .stat(targetPath)
    .then(() => true)
    .catch(() => false);
}

class GitOpsService {
  getWorkspaceGitStats(worktreePath: string, defaultBranch: string): Promise<WorkspaceGitStats> {
    return getWorkspaceGitStats(worktreePath, defaultBranch);
  }

  async commitIfNeeded(
    worktreePath: string,
    workspaceName: string,
    commitUncommitted: boolean
  ): Promise<void> {
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
    const commitResult = await gitCommand(['commit', '-m', commitMessage], worktreePath);
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

    const branchExists = await gitClient.branchExists(baseBranch);
    if (branchExists) {
      return;
    }

    const remoteBranchExists = await gitClient.branchExists(`origin/${baseBranch}`);
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
}

export const gitOpsService = new GitOpsService();
