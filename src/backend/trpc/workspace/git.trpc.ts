import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { isPathSafe } from '@/backend/lib/file-helpers';
import { getMergeBase, parseGitStatusOutput } from '@/backend/lib/git-helpers';
import { execCommand, gitCommand } from '@/backend/lib/shell';
import { archiveWorkspace } from '@/backend/orchestration/workspace-archive.orchestrator';
import { workspaceDataService } from '@/backend/services/workspace';
import { type Context, publicProcedure, router } from '@/backend/trpc/trpc';
import {
  getWorkspaceWithProjectAndWorktreeOrThrow,
  getWorkspaceWithWorktree,
} from './workspace-helpers';

const loggerName = 'workspace-git-trpc';
const getLogger = (ctx: Context) => ctx.appContext.services.createLogger(loggerName);

// =============================================================================
// Merge helpers
// =============================================================================

async function validateMergeContext(workspaceId: string) {
  const { workspace, worktreePath } = await getWorkspaceWithProjectAndWorktreeOrThrow(workspaceId);

  const branchName = workspace.branchName;
  if (!branchName) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Workspace has no branch name' });
  }

  const defaultBranch = workspace.project?.defaultBranch ?? 'main';
  const repoPath = workspace.project?.repoPath;
  const githubOwner = workspace.project?.githubOwner;
  const githubRepo = workspace.project?.githubRepo;

  if (!repoPath) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Project has no repo path' });
  }
  if (!(githubOwner && githubRepo)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Project has no GitHub owner/repo configured',
    });
  }

  return { branchName, defaultBranch, worktreePath, repoPath, githubOwner, githubRepo };
}

async function commitUncommittedChanges(worktreePath: string, defaultBranch: string) {
  const statusResult = await gitCommand(['status', '--porcelain'], worktreePath);
  if (!statusResult.stdout.trim()) {
    return;
  }
  await gitCommand(['add', '-A'], worktreePath);
  const commitResult = await gitCommand(
    ['commit', '--no-verify', '-m', `Auto-commit before merge to ${defaultBranch}`],
    worktreePath
  );
  if (commitResult.code !== 0) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Failed to commit changes: ${commitResult.stderr}`,
    });
  }
}

async function pushBranch(worktreePath: string, branchName: string) {
  const pushResult = await gitCommand(['push', '-u', 'origin', branchName], worktreePath);
  if (pushResult.code !== 0) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Failed to push branch: ${pushResult.stderr}`,
    });
  }
}

async function mergeViaGitHubApi(
  cwd: string,
  owner: string,
  repo: string,
  base: string,
  head: string
) {
  const result = await execCommand(
    'gh',
    [
      'api',
      `repos/${owner}/${repo}/merges`,
      '-f',
      `base=${base}`,
      '-f',
      `head=${head}`,
      '-f',
      `commit_message=Merge ${head} into ${base}`,
    ],
    { cwd }
  );
  if (result.code !== 0) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Merge failed: ${result.stderr}`,
    });
  }
}

export const workspaceGitRouter = router({
  // Get git status for workspace
  getGitStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const result = await getWorkspaceWithWorktree(input.workspaceId);
      if (!result) {
        return { files: [], hasUncommitted: false };
      }

      const gitResult = await gitCommand(['status', '--porcelain'], result.worktreePath);
      if (gitResult.code !== 0) {
        throw new Error(`Git status failed: ${gitResult.stderr}`);
      }

      const files = parseGitStatusOutput(gitResult.stdout);
      return { files, hasUncommitted: files.length > 0 };
    }),

  // Get only unstaged changes for workspace
  getUnstagedChanges: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const result = await getWorkspaceWithWorktree(input.workspaceId);
      if (!result) {
        return { files: [] };
      }

      const gitResult = await gitCommand(['status', '--porcelain'], result.worktreePath);
      if (gitResult.code !== 0) {
        throw new Error(`Git status failed: ${gitResult.stderr}`);
      }

      const files = parseGitStatusOutput(gitResult.stdout);
      // Filter to only unstaged files
      const unstagedFiles = files.filter((f) => !f.staged);
      return { files: unstagedFiles };
    }),

  // Get diff vs main branch for workspace
  getDiffVsMain: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
      // Use findByIdWithProject directly since we need project info
      const workspace = await workspaceDataService.findByIdWithProject(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      if (!workspace.worktreePath) {
        return { added: [], modified: [], deleted: [], noMergeBase: false };
      }

      // Get merge base with the project's default branch
      const defaultBranch = workspace.project?.defaultBranch ?? 'main';
      const mergeBase = await getMergeBase(workspace.worktreePath, defaultBranch);

      // If no merge base, the branch is not based on the default branch
      if (!mergeBase) {
        logger.warn(
          `No merge base found for workspace ${input.workspaceId} with branch ${defaultBranch}`
        );
        return { added: [], modified: [], deleted: [], noMergeBase: true };
      }

      // Get list of changed files with status
      const result = await gitCommand(['diff', '--name-status', mergeBase], workspace.worktreePath);

      if (result.code !== 0) {
        throw new Error(`Git diff failed: ${result.stderr}`);
      }

      // Parse output: each line is "STATUS\tFILENAME"
      const lines = result.stdout.split('\n').filter((line) => line.length > 0);
      const added: { path: string; status: 'added' }[] = [];
      const modified: { path: string; status: 'modified' }[] = [];
      const deleted: { path: string; status: 'deleted' }[] = [];

      for (const line of lines) {
        const [status, filePath] = line.split('\t');
        if (!filePath) {
          // Log unexpected git output format for debugging
          logger.warn(`Unexpected git diff output format: ${line}`);
          continue;
        }

        if (status === 'A') {
          added.push({ path: filePath, status: 'added' });
        } else if (status === 'M') {
          modified.push({ path: filePath, status: 'modified' });
        } else if (status === 'D') {
          deleted.push({ path: filePath, status: 'deleted' });
        }
        // Silently ignore other status codes (R for rename, C for copy, etc.)
      }

      return { added, modified, deleted, noMergeBase: false };
    }),

  // Get files changed in commits not yet pushed to upstream
  getUnpushedFiles: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const result = await getWorkspaceWithWorktree(input.workspaceId);
      if (!result) {
        return { files: [], hasUpstream: false };
      }

      const upstreamResult = await gitCommand(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        result.worktreePath
      );
      if (upstreamResult.code !== 0) {
        // No upstream configured (or detached HEAD); treat as unknown rather than throwing.
        return { files: [], hasUpstream: false };
      }

      const upstreamRef = upstreamResult.stdout.trim();
      if (!upstreamRef) {
        return { files: [], hasUpstream: false };
      }

      const diffResult = await gitCommand(
        // Use three-dot to capture only changes introduced by local commits
        // since divergence from upstream (exclude remote-only changes).
        ['diff', '--name-only', `${upstreamRef}...HEAD`],
        result.worktreePath
      );
      if (diffResult.code !== 0) {
        throw new Error(`Git diff failed: ${diffResult.stderr}`);
      }

      const files = diffResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      return { files, hasUpstream: true };
    }),

  // Get file diff for workspace (relative to project's default branch)
  getFileDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string(),
      })
    )
    .query(async ({ input }) => {
      const { workspace, worktreePath } = await getWorkspaceWithProjectAndWorktreeOrThrow(
        input.workspaceId
      );

      // Validate path is safe
      if (!(await isPathSafe(worktreePath, input.filePath))) {
        throw new Error('Invalid file path');
      }

      // Get merge base with the project's default branch
      const defaultBranch = workspace.project?.defaultBranch ?? 'main';
      const mergeBase = await getMergeBase(worktreePath, defaultBranch);

      // Try to get diff from merge base (shows all changes from main)
      // Falls back to HEAD if no merge base found
      const diffBase = mergeBase ?? 'HEAD';
      let result = await gitCommand(['diff', diffBase, '--', input.filePath], worktreePath);

      // If empty, try without base (for untracked files or other scenarios)
      if (result.stdout.trim() === '' && result.code === 0) {
        result = await gitCommand(['diff', '--', input.filePath], worktreePath);
      }

      // If still empty, try to show the file for new untracked files
      if (result.stdout.trim() === '' && result.code === 0) {
        // For untracked files, show the entire file as an addition
        const fullPath = path.join(worktreePath, input.filePath);
        try {
          const content = await readFile(fullPath, 'utf-8');
          // Format as a unified diff for a new file
          const lines = content.split('\n');
          const diffContent = [
            `diff --git a/${input.filePath} b/${input.filePath}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${input.filePath}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((line) => `+${line}`),
          ].join('\n');
          return { diff: diffContent };
        } catch {
          // File doesn't exist or can't be read
          return { diff: '' };
        }
      }

      if (result.code !== 0) {
        throw new Error(`Git diff failed: ${result.stderr}`);
      }

      return { diff: result.stdout };
    }),

  // Merge workspace branch directly into the default branch (no PR)
  mergeToMain: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
      const mergeContext = await validateMergeContext(input.workspaceId);
      const { branchName, defaultBranch, worktreePath, repoPath, githubOwner, githubRepo } =
        mergeContext;

      logger.info('Merging workspace branch to default branch', {
        workspaceId: input.workspaceId,
        branchName,
        defaultBranch,
      });

      await commitUncommittedChanges(worktreePath, defaultBranch);
      await pushBranch(worktreePath, branchName);
      await mergeViaGitHubApi(worktreePath, githubOwner, githubRepo, defaultBranch, branchName);

      // Pull the merge into the main repo so local is up to date
      await gitCommand(['pull', 'origin', defaultBranch], repoPath);

      // Clean up: delete remote branch
      await gitCommand(['push', 'origin', '--delete', branchName], worktreePath).catch(() => {
        logger.warn('Failed to delete remote branch after merge', { branchName });
      });

      // Archive the workspace
      const workspaceWithProject = await workspaceDataService.findByIdWithProject(
        input.workspaceId
      );
      if (workspaceWithProject) {
        try {
          await archiveWorkspace(
            workspaceWithProject,
            { commitUncommitted: false },
            ctx.appContext.services
          );
        } catch (archiveError) {
          logger.warn('Failed to archive workspace after merge', {
            workspaceId: input.workspaceId,
            error: archiveError instanceof Error ? archiveError.message : String(archiveError),
          });
        }
      }

      logger.info('Successfully merged workspace branch', {
        workspaceId: input.workspaceId,
        branchName,
        defaultBranch,
      });

      return { success: true, defaultBranch, branchName };
    }),
});
