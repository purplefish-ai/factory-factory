import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  type FileEntry,
  getLanguageFromPath,
  isBinaryContent,
  isPathSafe,
  MAX_FILE_SIZE,
} from '../../lib/file-helpers';
import { createLogger } from '../../services/logger.service';
import { publicProcedure, router } from '../trpc';
import { getWorkspaceWithWorktree, getWorkspaceWithWorktreeOrThrow } from './workspace-helpers';

const logger = createLogger('workspace-files-trpc');

export const workspaceFilesRouter = router({
  // List files in directory
  listFiles: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const result = await getWorkspaceWithWorktree(input.workspaceId);

      logger.info('listFiles called', {
        workspaceId: input.workspaceId,
        worktreePath: result?.worktreePath,
        requestedPath: input.path,
      });

      if (!result) {
        logger.warn('No worktreePath for workspace', { workspaceId: input.workspaceId });
        return { entries: [], hasWorktree: false };
      }

      const { worktreePath } = result;
      const relativePath = input.path ?? '';

      // Validate path is safe
      if (relativePath && !(await isPathSafe(worktreePath, relativePath))) {
        throw new Error('Invalid file path');
      }

      const fullPath = path.join(worktreePath, relativePath);

      try {
        const dirents = await readdir(fullPath, { withFileTypes: true });

        const entries: FileEntry[] = [];
        for (const dirent of dirents) {
          // Skip .git directory
          if (dirent.name === '.git') {
            continue;
          }

          // Skip hidden files starting with . (optional, could make configurable)
          // if (dirent.name.startsWith('.')) continue;

          const entryPath = relativePath ? path.join(relativePath, dirent.name) : dirent.name;
          entries.push({
            name: dirent.name,
            type: dirent.isDirectory() ? 'directory' : 'file',
            path: entryPath,
          });
        }

        // Sort: directories first, then alphabetically
        entries.sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

        logger.info('listFiles returning entries', {
          workspaceId: input.workspaceId,
          fullPath,
          entryCount: entries.length,
        });

        return { entries, hasWorktree: true };
      } catch (error) {
        logger.error('listFiles error', error as Error, {
          workspaceId: input.workspaceId,
          fullPath,
          errorCode: (error as NodeJS.ErrnoException).code,
        });
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { entries: [], hasWorktree: true };
        }
        throw error;
      }
    }),

  // Read file content
  readFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string(),
      })
    )
    .query(async ({ input }) => {
      const { worktreePath } = await getWorkspaceWithWorktreeOrThrow(input.workspaceId);

      // Validate path is safe
      if (!(await isPathSafe(worktreePath, input.path))) {
        throw new Error('Invalid file path');
      }

      const fullPath = path.join(worktreePath, input.path);

      // Get file stats to check size
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        throw new Error('Path is a directory');
      }

      const fileSize = stats.size;
      const truncated = fileSize > MAX_FILE_SIZE;

      // Read file content
      const buffer = await readFile(fullPath);

      // Check if binary
      if (isBinaryContent(buffer)) {
        return {
          content: '[Binary file - cannot display]',
          language: 'text',
          truncated: false,
          size: fileSize,
          isBinary: true,
        };
      }

      // Convert to string, potentially truncated
      let content = buffer.toString('utf-8');
      if (truncated) {
        content = content.slice(0, MAX_FILE_SIZE);
      }

      return {
        content,
        language: getLanguageFromPath(input.path),
        truncated,
        size: fileSize,
        isBinary: false,
      };
    }),
});
