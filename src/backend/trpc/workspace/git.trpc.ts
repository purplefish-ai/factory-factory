import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isPathSafe } from '../../lib/file-helpers';
import { getMergeBase, parseGitStatusOutput } from '../../lib/git-helpers';
import { gitCommand } from '../../lib/shell';
import { workspaceAccessor } from '../../resource_accessors/workspace.accessor';
import { createLogger } from '../../services/logger.service';
import { publicProcedure, router } from '../trpc';

const logger = createLogger('workspace-git-trpc');

export const workspaceGitRouter = router({
  // Get git status for workspace
  getGitStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      if (!workspace.worktreePath) {
        return { files: [], hasUncommitted: false };
      }

      const result = await gitCommand(['status', '--porcelain'], workspace.worktreePath);
      if (result.code !== 0) {
        throw new Error(`Git status failed: ${result.stderr}`);
      }

      const files = parseGitStatusOutput(result.stdout);
      return { files, hasUncommitted: files.length > 0 };
    }),

  // Get only unstaged changes for workspace
  getUnstagedChanges: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      if (!workspace.worktreePath) {
        return { files: [] };
      }

      const result = await gitCommand(['status', '--porcelain'], workspace.worktreePath);
      if (result.code !== 0) {
        throw new Error(`Git status failed: ${result.stderr}`);
      }

      const files = parseGitStatusOutput(result.stdout);
      // Filter to only unstaged files
      const unstagedFiles = files.filter((f) => !f.staged);
      return { files: unstagedFiles };
    }),

  // Get diff vs main branch for workspace
  getDiffVsMain: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findByIdWithProject(input.workspaceId);
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

  // Get file diff for workspace (relative to project's default branch)
  getFileDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string(),
      })
    )
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findByIdWithProject(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      if (!workspace.worktreePath) {
        throw new Error('Workspace has no worktree path');
      }

      // Validate path is safe
      if (!(await isPathSafe(workspace.worktreePath, input.filePath))) {
        throw new Error('Invalid file path');
      }

      // Get merge base with the project's default branch
      const defaultBranch = workspace.project?.defaultBranch ?? 'main';
      const mergeBase = await getMergeBase(workspace.worktreePath, defaultBranch);

      // Try to get diff from merge base (shows all changes from main)
      // Falls back to HEAD if no merge base found
      const diffBase = mergeBase ?? 'HEAD';
      let result = await gitCommand(
        ['diff', diffBase, '--', input.filePath],
        workspace.worktreePath
      );

      // If empty, try without base (for untracked files or other scenarios)
      if (result.stdout.trim() === '' && result.code === 0) {
        result = await gitCommand(['diff', '--', input.filePath], workspace.worktreePath);
      }

      // If still empty, try to show the file for new untracked files
      if (result.stdout.trim() === '' && result.code === 0) {
        // For untracked files, show the entire file as an addition
        const fullPath = path.join(workspace.worktreePath, input.filePath);
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
