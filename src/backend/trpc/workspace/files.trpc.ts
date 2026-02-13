import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  type FileEntry,
  isBinaryContent,
  isPathSafe,
  MAX_FILE_SIZE,
} from '@/backend/lib/file-helpers';
import { type Context, publicProcedure, router } from '@/backend/trpc/trpc';
import { getLanguageFromPath } from '@/lib/language-detection';
import { getWorkspaceWithWorktree, getWorkspaceWithWorktreeOrThrow } from './workspace-helpers';

const loggerName = 'workspace-files-trpc';
const getLogger = (ctx: Context) => ctx.appContext.services.createLogger(loggerName);

const SCREENSHOT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

async function validateScreenshotPath(
  workspaceId: string,
  screenshotPath: string
): Promise<string> {
  if (!screenshotPath.startsWith('.factory-factory/screenshots/')) {
    throw new Error('Invalid screenshot path');
  }

  const { worktreePath } = await getWorkspaceWithWorktreeOrThrow(workspaceId);

  if (!(await isPathSafe(worktreePath, screenshotPath))) {
    throw new Error('Invalid file path');
  }

  const ext = path.extname(screenshotPath).toLowerCase();
  if (!SCREENSHOT_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error('Invalid image format');
  }

  return path.join(worktreePath, screenshotPath);
}

/**
 * Recursively list all files in a directory, excluding common ignore patterns
 */
async function listFilesRecursive(
  rootPath: string,
  currentPath = '',
  maxDepth = 10,
  currentDepth = 0
): Promise<string[]> {
  if (currentDepth >= maxDepth) {
    return [];
  }

  const fullPath = path.join(rootPath, currentPath);
  const files: string[] = [];

  // Common patterns to ignore
  const ignorePatterns = [
    '.git',
    'node_modules',
    '.next',
    'dist',
    'build',
    '.turbo',
    'coverage',
    '.vscode',
    '.idea',
  ];

  try {
    const dirents = await readdir(fullPath, { withFileTypes: true });

    for (const dirent of dirents) {
      // Skip ignored patterns
      if (ignorePatterns.includes(dirent.name)) {
        continue;
      }

      // Skip hidden files/folders (optional - could make configurable)
      if (dirent.name.startsWith('.')) {
        continue;
      }

      const relativePath = currentPath ? path.join(currentPath, dirent.name) : dirent.name;

      if (dirent.isDirectory()) {
        // Recursively list files in subdirectory
        const subFiles = await listFilesRecursive(
          rootPath,
          relativePath,
          maxDepth,
          currentDepth + 1
        );
        files.push(...subFiles);
      } else {
        // Add file to list
        files.push(relativePath);
      }
    }
  } catch (_error) {
    // Silently skip directories we can't read
    return files;
  }

  return files;
}

/**
 * Comparator for sorting files by relevance
 */
function compareFilesByRelevance(a: string, b: string, queryLower?: string): number {
  // Compare basenames if query provided
  if (queryLower) {
    const aBasename = path.basename(a).toLowerCase();
    const bBasename = path.basename(b).toLowerCase();

    // Exact matches first
    const aExact = aBasename === queryLower;
    const bExact = bBasename === queryLower;
    if (aExact !== bExact) {
      return aExact ? -1 : 1;
    }

    // Prefix matches next
    const aStarts = aBasename.startsWith(queryLower);
    const bStarts = bBasename.startsWith(queryLower);
    if (aStarts !== bStarts) {
      return aStarts ? -1 : 1;
    }
  }

  // Sort by depth (fewer slashes first)
  const aDepth = a.split('/').length;
  const bDepth = b.split('/').length;
  if (aDepth !== bDepth) {
    return aDepth - bDepth;
  }

  // Finally alphabetically
  return a.localeCompare(b);
}

export const workspaceFilesRouter = router({
  // List all files recursively (for autocomplete)
  listAllFiles: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        query: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
      const result = await getWorkspaceWithWorktree(input.workspaceId);

      if (!result) {
        logger.warn('No worktreePath for workspace', { workspaceId: input.workspaceId });
        return { files: [], hasWorktree: false };
      }

      const { worktreePath } = result;

      try {
        // Get all files recursively
        let files = await listFilesRecursive(worktreePath);

        // Filter by query if provided (case-insensitive)
        if (input.query) {
          const queryLower = input.query.toLowerCase();
          files = files.filter((file) => file.toLowerCase().includes(queryLower));
        }

        // Sort by relevance (prefer shorter paths, exact matches first)
        const queryLower = input.query?.toLowerCase();
        files.sort((a, b) => compareFilesByRelevance(a, b, queryLower));

        // Limit results
        files = files.slice(0, input.limit);

        logger.info('listAllFiles returning files', {
          workspaceId: input.workspaceId,
          query: input.query,
          totalFiles: files.length,
        });

        return { files, hasWorktree: true };
      } catch (error) {
        logger.error('listAllFiles error', error as Error, {
          workspaceId: input.workspaceId,
        });
        throw error;
      }
    }),

  // List files in directory
  listFiles: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
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

  // List screenshots in .factory-factory/screenshots/
  listScreenshots: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const result = await getWorkspaceWithWorktree(input.workspaceId);
      if (!result) {
        return { screenshots: [], hasWorktree: false };
      }

      const screenshotsDir = path.join(result.worktreePath, '.factory-factory', 'screenshots');

      try {
        const dirents = await readdir(screenshotsDir, { withFileTypes: true });
        const screenshots: Array<{ name: string; path: string; size: number }> = [];

        for (const dirent of dirents) {
          if (!dirent.isFile()) {
            continue;
          }
          const ext = path.extname(dirent.name).toLowerCase();
          if (!SCREENSHOT_IMAGE_EXTENSIONS.has(ext)) {
            continue;
          }

          const filePath = path.join(screenshotsDir, dirent.name);
          const stats = await stat(filePath);
          screenshots.push({
            name: dirent.name,
            path: `.factory-factory/screenshots/${dirent.name}`,
            size: stats.size,
          });
        }

        screenshots.sort((a, b) => a.name.localeCompare(b.name));
        return { screenshots, hasWorktree: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { screenshots: [], hasWorktree: true };
        }
        throw error;
      }
    }),

  // Read a screenshot as base64
  readScreenshot: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string(),
      })
    )
    .query(async ({ input }) => {
      const fullPath = await validateScreenshotPath(input.workspaceId, input.path);
      const buffer = await readFile(fullPath);
      const ext = path.extname(input.path).toLowerCase();

      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
      };

      return {
        data: buffer.toString('base64'),
        mimeType: mimeMap[ext] ?? 'image/png',
        name: path.basename(input.path),
      };
    }),

  // Delete a screenshot
  deleteScreenshot: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const fullPath = await validateScreenshotPath(input.workspaceId, input.path);
      await unlink(fullPath);
      return { success: true };
    }),
});
