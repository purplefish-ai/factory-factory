import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitClientFactory } from '@/backend/clients/git.client';
import { ApplicationError } from '@/backend/lib/application-error';
import { pathExists } from '@/backend/lib/file-helpers';
import { gitCommand } from '@/backend/lib/shell';
import { createLogger } from '@/backend/services/logger.service';
import {
  getStats,
  type WorkspaceGitStats,
  workspaceGitStateService,
} from '@/backend/services/workspace-git-state.service';
import type { WorkspaceInitGuard } from '@/shared/workspace-init-retry';
import { parseGitHubRemoteUrl } from './project-repository-inspector';

const logger = createLogger('git-ops');

export type { WorkspaceGitStats };

interface ProjectPaths {
  repoPath: string;
  worktreeBasePath: string;
}

interface CommitIfNeededOptions {
  removeGitIndexLock?: boolean;
}

/** What a worktree has checked out; each field is null when Git can't answer. */
export interface WorktreeCheckoutIdentity {
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  headSha: string | null;
  /** GitHub repository of the `origin` remote. */
  origin: { owner: string; repo: string } | null;
}

/** Private namespace for refs the app fetches without touching branches. */
export const APP_PRIVATE_REF_PREFIX = 'refs/factory-factory/';
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function assertAppPrivateRef(ref: string): void {
  if (!(ref.startsWith(APP_PRIVATE_REF_PREFIX) && /^[A-Za-z0-9/_-]+$/.test(ref))) {
    throw new ApplicationError('INTERNAL_ERROR', `Refusing to write non-private ref: ${ref}`);
  }
}

function assertCommitSha(sha: string): void {
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new ApplicationError('INTERNAL_ERROR', `Invalid commit SHA: ${sha}`);
  }
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
   * Already-computed stats for a worktree, or null when none are cached.
   *
   * Never spawns `git`. For callers that must answer without waiting on a
   * recompute; see {@link WorkspaceGitStateService.getCachedSnapshot}.
   */
  getCachedWorkspaceGitStats(
    worktreePath: string,
    defaultBranch: string
  ): WorkspaceGitStats | null {
    const snapshot = workspaceGitStateService.getCachedSnapshot({ worktreePath, defaultBranch });
    return snapshot ? getStats(snapshot) : null;
  }

  /**
   * Check if a path is a valid git repository (worktree or regular repo).
   * Returns true if git commands can be run in this directory.
   */
  async isValidGitRepo(worktreePath: string): Promise<boolean> {
    const result = await gitCommand(['rev-parse', '--git-dir'], worktreePath);
    return result.code === 0;
  }

  private async resolveIndexLockPath(worktreePath: string): Promise<string> {
    const gitDirResult = await gitCommand(['rev-parse', '--absolute-git-dir'], worktreePath);
    const gitDir = gitDirResult.stdout.trim();
    if (gitDirResult.code !== 0 || gitDir.length === 0) {
      throw new ApplicationError('INTERNAL_ERROR', 'Failed to resolve Git index lock', {
        cause: gitDirResult,
      });
    }
    return path.join(path.resolve(worktreePath, gitDir), 'index.lock');
  }

  private async createGitOperationError(
    worktreePath: string,
    result: Awaited<ReturnType<typeof gitCommand>>,
    fallbackMessage: string
  ): Promise<ApplicationError> {
    try {
      const indexLockPath = await this.resolveIndexLockPath(worktreePath);
      if (await pathExists(indexLockPath)) {
        return new ApplicationError(
          'CONFLICT',
          'Git is locked. Another Git operation may be running, or an earlier operation may have stopped unexpectedly.',
          {
            cause: result,
            kind: 'GIT_INDEX_LOCKED',
          }
        );
      }
    } catch {
      // Classification is best-effort. Preserve the original Git failure when
      // the worktree's Git metadata cannot be inspected safely.
    }

    return new ApplicationError('INTERNAL_ERROR', fallbackMessage, { cause: result });
  }

  private async removeGitIndexLock(worktreePath: string): Promise<void> {
    const indexLockPath = await this.resolveIndexLockPath(worktreePath);
    try {
      await fs.rm(indexLockPath, { force: true });
    } catch (error) {
      throw new ApplicationError('INTERNAL_ERROR', 'Failed to remove Git index lock', {
        cause: error,
      });
    }
  }

  async commitIfNeeded(
    worktreePath: string,
    workspaceName: string,
    options: CommitIfNeededOptions = {}
  ): Promise<void> {
    // Check if this is a valid git repo first - if not, skip commit
    // This can happen if the worktree was corrupted or the .git file was removed
    const isValid = await this.isValidGitRepo(worktreePath);
    if (!isValid) {
      return;
    }

    if (options.removeGitIndexLock) {
      await this.removeGitIndexLock(worktreePath);
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

    try {
      const addResult = await gitCommand(['add', '-A'], worktreePath);
      if (addResult.code !== 0) {
        throw await this.createGitOperationError(worktreePath, addResult, 'Git add failed');
      }

      const commitMessage = `Archive workspace ${workspaceName}`;
      const commitResult = await gitCommand(
        ['commit', '-m', commitMessage, '--no-verify'],
        worktreePath
      );
      if (commitResult.code !== 0) {
        throw await this.createGitOperationError(worktreePath, commitResult, 'Git commit failed');
      }
    } finally {
      workspaceGitStateService.invalidate(worktreePath);
    }
  }

  async removeWorktree(
    worktreePath: string,
    project: ProjectPaths,
    guard?: WorkspaceInitGuard
  ): Promise<void> {
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

    // Git records real paths. Resolve the base separately so a missing worktree
    // still matches its registration and can be removed through Git.
    let canonicalWorktreePath = expectedWorktreePath;
    try {
      canonicalWorktreePath = path.join(
        await fs.realpath(path.dirname(expectedWorktreePath)),
        worktreeName
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      logger.warn(
        'Cannot resolve worktree base; checking only the configured path. Restore missing base symlinks to clean up canonical Git registrations.',
        { worktreePath, worktreeBasePath: path.dirname(expectedWorktreePath) }
      );
    }
    const registeredWorktree = (await gitClient.listWorktreesWithBranches()).find(
      (entry) => path.resolve(entry.path) === canonicalWorktreePath
    );
    if (registeredWorktree) {
      try {
        await guard?.check();
        guard?.assertCurrent();
        await workspaceGitStateService.withWatchersSuspended(worktreePath, () =>
          gitClient.deleteWorktree(worktreeName)
        );
      } catch (error) {
        // A later snapshot read reinstalls watchers if the worktree survives.
        workspaceGitStateService.invalidate(worktreePath);
        throw error;
      }
      return;
    }

    if (await pathExists(worktreePath)) {
      try {
        await guard?.check();
        guard?.assertCurrent();
        await workspaceGitStateService.withWatchersSuspended(worktreePath, () =>
          fs.rm(worktreePath, { recursive: true, force: true })
        );
        return;
      } catch (error) {
        // A later snapshot read reinstalls watchers if the worktree survives.
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

  /** Absence preflight only: this does not reserve a path or prove later creation ownership. */
  async prepareWorktreeCreation(project: ProjectPaths, worktreeName: string) {
    const gitClient = GitClientFactory.forProject(project);
    const worktreePath = gitClient.getWorktreePath(worktreeName);
    if (await worktreeEntryExists(worktreePath)) {
      throw new Error('Refusing event creation at a preexisting worktree path');
    }
    // Git creation also ensures this base; retain its identity for later absence inspection.
    await fs.mkdir(project.worktreeBasePath, { recursive: true });
    const canonicalBasePath = await fs.realpath(project.worktreeBasePath);
    if (!(await this.confirmWorktreeAbsent(worktreePath, project, canonicalBasePath))) {
      throw new Error('Refusing event creation at a retained Git worktree registration');
    }
    return { worktreePath, canonicalBasePath };
  }

  async confirmWorktreeAbsent(
    worktreePath: string,
    project: ProjectPaths,
    expectedCanonicalBase: string
  ): Promise<boolean> {
    const gitClient = GitClientFactory.forProject(project);
    const name = path.basename(worktreePath);
    if (path.resolve(worktreePath) !== path.resolve(gitClient.getWorktreePath(name))) {
      throw new Error('Worktree candidate does not match the configured project path');
    }
    if (await worktreeEntryExists(worktreePath)) {
      return false;
    }
    const canonicalBase = await fs.realpath(project.worktreeBasePath);
    if (canonicalBase !== expectedCanonicalBase) {
      throw new Error('Worktree base identity changed during creation');
    }
    const canonicalPath = path.join(canonicalBase, name);
    const entries = await gitClient.listWorktreesWithBranches();
    return !entries.some((entry) => path.resolve(entry.path) === canonicalPath);
  }

  async createWorktree(
    project: ProjectPaths,
    worktreeName: string,
    baseBranch: string,
    options: { branchPrefix?: string; workspaceName: string; guard?: WorkspaceInitGuard }
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
    branchRef: string,
    guard?: WorkspaceInitGuard
  ): Promise<{ worktreePath: string; branchName: string }> {
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    const worktreePath = gitClient.getWorktreePath(worktreeName);
    try {
      const worktreeInfo = await gitClient.createWorktreeFromExistingBranch(
        worktreeName,
        branchRef,
        guard ? { guard } : undefined
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
    let worktreeBasePath = path.resolve(project.worktreeBasePath);
    try {
      worktreeBasePath = await fs.realpath(worktreeBasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      logger.warn(
        'Cannot resolve worktree base for branch checkout check; matching configured path',
        {
          worktreeBasePath,
        }
      );
    }
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

  async getCheckoutIdentity(worktreePath: string): Promise<WorktreeCheckoutIdentity> {
    const [branch, head, origin] = await Promise.all([
      gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath),
      gitCommand(['rev-parse', 'HEAD'], worktreePath),
      gitCommand(['remote', 'get-url', 'origin'], worktreePath),
    ]);
    const branchName = branch.code === 0 ? branch.stdout.trim() : '';
    const headSha = head.code === 0 ? head.stdout.trim() : '';
    return {
      branch: branchName && branchName !== 'HEAD' ? branchName : null,
      headSha: COMMIT_SHA_PATTERN.test(headSha) ? headSha : null,
      origin: origin.code === 0 ? parseGitHubRemoteUrl(origin.stdout.trim()) : null,
    };
  }

  /** True when `ancestor` is `descendant` or reachable from it; false if either is missing. */
  async isAncestorCommit(
    worktreePath: string,
    ancestor: string,
    descendant: string
  ): Promise<boolean> {
    assertCommitSha(ancestor);
    assertCommitSha(descendant);
    const result = await gitCommand(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      worktreePath
    );
    return result.code === 0;
  }

  async hasCommit(worktreePath: string, sha: string): Promise<boolean> {
    assertCommitSha(sha);
    const result = await gitCommand(['cat-file', '-e', `${sha}^{commit}`], worktreePath);
    return result.code === 0;
  }

  /**
   * Fetch a pull request's head from `origin` into an app-private ref. Leaves
   * the working tree, index, branches and FETCH_HEAD alone, so an agent working
   * in the same worktree is unaffected. `refs/pull/<n>/head` also covers PRs
   * opened from forks.
   */
  async fetchPullRequestHead(worktreePath: string, prNumber: number, ref: string): Promise<void> {
    assertAppPrivateRef(ref);
    if (!(Number.isInteger(prNumber) && prNumber > 0)) {
      throw new ApplicationError('INTERNAL_ERROR', `Invalid pull request number: ${prNumber}`);
    }
    const result = await gitCommand(
      [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        `+refs/pull/${prNumber}/head:${ref}`,
      ],
      worktreePath
    );
    if (result.code !== 0) {
      throw new ApplicationError(
        'INTERNAL_ERROR',
        `Failed to fetch pull request head: ${(result.stderr || result.stdout).trim()}`,
        { cause: result }
      );
    }
  }

  async deletePrivateRef(worktreePath: string, ref: string): Promise<void> {
    assertAppPrivateRef(ref);
    const result = await gitCommand(['update-ref', '-d', ref], worktreePath);
    if (result.code !== 0) {
      throw new ApplicationError(
        'INTERNAL_ERROR',
        `Failed to delete ref ${ref}: ${(result.stderr || result.stdout).trim()}`,
        { cause: result }
      );
    }
  }
}

export const gitOpsService = new GitOpsService();

async function worktreeEntryExists(worktreePath: string): Promise<boolean> {
  try {
    await fs.lstat(worktreePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
