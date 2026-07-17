import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isPathSafe } from '@/backend/lib/file-helpers';
import { gitCommand } from '@/backend/lib/shell';
import { workspaceDataService } from '@/backend/services/workspace';
import { workspaceGitStateService } from '@/backend/services/workspace-git-state.service';
import { type Context, publicProcedure, router } from '@/backend/trpc/trpc';
import { getWorkspaceWithProjectAndWorktreeOrThrow } from './workspace-helpers';

const loggerName = 'workspace-git-trpc';
const getLogger = (ctx: Context) => ctx.appContext.services.createLogger(loggerName);

async function getSnapshotForWorkspace(workspaceId: string) {
  const workspace = await workspaceDataService.findByIdWithProject(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  if (!workspace.worktreePath) {
    return null;
  }
  return workspaceGitStateService.getSnapshot({
    worktreePath: workspace.worktreePath,
    defaultBranch: workspace.project?.defaultBranch ?? 'main',
  });
}

export const workspaceGitRouter = router({
  // Get git status for workspace
  getGitStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const snapshot = await getSnapshotForWorkspace(input.workspaceId);
      if (!snapshot) {
        return { files: [], hasUncommitted: false };
      }
      if (snapshot.status.error) {
        throw new Error(`Git status failed: ${snapshot.status.error}`);
      }

      return {
        files: snapshot.status.files,
        hasUncommitted: snapshot.status.hasUncommitted,
      };
    }),

  // Get only unstaged changes for workspace
  getUnstagedChanges: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const snapshot = await getSnapshotForWorkspace(input.workspaceId);
      if (!snapshot) {
        return { files: [] };
      }
      if (snapshot.status.error) {
        throw new Error(`Git status failed: ${snapshot.status.error}`);
      }

      const unstagedFiles = snapshot.status.files.filter((file) => !file.staged);
      return { files: unstagedFiles };
    }),

  // Get diff vs main branch for workspace
  getDiffVsMain: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
      const snapshot = await getSnapshotForWorkspace(input.workspaceId);
      if (!snapshot) {
        return { added: [], modified: [], deleted: [], noMergeBase: false };
      }
      if (snapshot.base.error) {
        throw new Error(`Git diff failed: ${snapshot.base.error}`);
      }
      if (snapshot.base.noMergeBase) {
        logger.warn(
          `No merge base found for workspace ${input.workspaceId} with branch ${snapshot.defaultBranch}`
        );
      }

      return {
        added: snapshot.base.added,
        modified: snapshot.base.modified,
        deleted: snapshot.base.deleted,
        noMergeBase: snapshot.base.noMergeBase,
      };
    }),

  // Get files changed in commits not yet pushed to upstream
  getUnpushedFiles: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const snapshot = await getSnapshotForWorkspace(input.workspaceId);
      if (!snapshot) {
        return { files: [], hasUpstream: false };
      }
      if (snapshot.upstream.error) {
        throw new Error(`Git diff failed: ${snapshot.upstream.error}`);
      }

      return {
        files: snapshot.upstream.files,
        hasUpstream: snapshot.upstream.hasUpstream,
      };
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

      const defaultBranch = workspace.project?.defaultBranch ?? 'main';
      const snapshot = await workspaceGitStateService.getSnapshot({ worktreePath, defaultBranch });
      const mergeBase = snapshot.base.mergeBase;

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
});
