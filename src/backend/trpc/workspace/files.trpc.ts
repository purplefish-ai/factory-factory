import { type Stats } from 'node:fs';
import { readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { toError } from '@/backend/lib/error-utils';
import {
  type FileEntry,
  isBinaryContent,
  isPathSafe,
  searchFilesRecursive,
} from '@/backend/lib/file-helpers';
import { readFilePrefix } from '@/backend/lib/file-preview';
import { type Context, publicProcedure, router } from '@/backend/trpc/trpc';
import { getLanguageFromPath } from '@/lib/language-detection';
import {
  getWorkspaceWithWorktree,
  getWorkspaceWithWorktreeOrThrow,
  getWorkspaceWorktreeContextOrThrow,
} from './workspace-helpers';

const loggerName = 'workspace-files-trpc';
const getLogger = (ctx: Context) => ctx.appContext.services.createLogger(loggerName);

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const SCREENSHOT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

async function previewFile(
  fullPath: string,
  displayPath: string,
  boundary?: { root: string; validate: (stats: Stats) => Promise<void> }
) {
  const mimeType = IMAGE_MIME_TYPES[path.extname(displayPath).toLowerCase()];
  if (mimeType) {
    const { buffer, size, truncated } = await readFilePrefix(fullPath, {
      maxBytes: MAX_IMAGE_BYTES,
      withinDirectory: boundary?.root,
      validateFile: async (stats) => {
        if (stats.size > MAX_IMAGE_BYTES) {
          throw new Error('Image is too large to preview (maximum 20 MB)');
        }
        await boundary?.validate(stats);
      },
    });
    if (truncated) {
      throw new Error('Image is too large to preview (maximum 20 MB)');
    }
    return {
      content: '',
      language: 'image',
      truncated: false,
      size,
      isBinary: true,
      image: { mimeType, data: buffer.toString('base64') },
    };
  }

  const { buffer, size, truncated } = await readFilePrefix(fullPath, {
    withinDirectory: boundary?.root,
    validateFile: boundary?.validate,
  });
  if (isBinaryContent(buffer)) {
    return {
      content: '[Binary file - cannot display]',
      language: 'text',
      truncated: false,
      size,
      isBinary: true,
    };
  }

  // Hold back any incomplete UTF-8 character at a truncated byte boundary.
  const decoder = new StringDecoder('utf8');
  return {
    content: truncated ? decoder.write(buffer) : decoder.end(buffer),
    language: getLanguageFromPath(displayPath),
    truncated,
    size,
    isBinary: false,
  };
}

async function previewTemporaryFile(filePath: string) {
  const invalidPath = () => new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid file path' });
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
    filePath.includes('\0') ||
    filePath.split('/').includes('..')
  ) {
    throw invalidPath();
  }

  const tempRoot = '/tmp';
  const canonicalRoot = await realpath(tempRoot);
  const fullPath = path.normalize(filePath);
  if (!(fullPath.startsWith(`${tempRoot}/`) || fullPath.startsWith(`${canonicalRoot}/`))) {
    throw invalidPath();
  }

  try {
    const canonicalPath = await realpath(fullPath);
    if (!canonicalPath.startsWith(`${canonicalRoot}/`)) {
      throw invalidPath();
    }
    return await previewFile(canonicalPath, fullPath, {
      root: canonicalRoot,
      async validate(opened) {
        // Check both the linked path and the opened inode when validating the preview.
        if ((await realpath(fullPath)) !== canonicalPath) {
          throw invalidPath();
        }
        const current = await stat(canonicalPath);
        if (
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          (await realpath(fullPath)) !== canonicalPath
        ) {
          throw invalidPath();
        }
      },
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'File no longer exists' });
    }
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
      throw invalidPath();
    }
    throw error;
  }
}

async function validateScreenshotPath(
  workspaceDataService: Context['appContext']['services']['workspaceDataService'],
  workspaceId: string,
  screenshotPath: string
): Promise<{ fullPath: string; worktreePath: string }> {
  if (!screenshotPath.startsWith('.factory-factory/screenshots/')) {
    throw new Error('Invalid screenshot path');
  }

  const { worktreePath } = await getWorkspaceWithWorktreeOrThrow(workspaceDataService, workspaceId);

  if (!(await isPathSafe(worktreePath, screenshotPath))) {
    throw new Error('Invalid file path');
  }

  const ext = path.extname(screenshotPath).toLowerCase();
  if (!SCREENSHOT_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error('Invalid image format');
  }

  return { fullPath: path.join(worktreePath, screenshotPath), worktreePath };
}

export const workspaceFilesRouter = router({
  // Recursively search for autocomplete or the Files tab.
  listAllFiles: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        query: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        match: z.literal('fuzzy').optional(),
      })
    )
    .query(async ({ ctx, input, signal }) => {
      const logger = getLogger(ctx);
      const result = await getWorkspaceWithWorktree(
        ctx.appContext.services.workspaceDataService,
        input.workspaceId
      );

      if (!result) {
        logger.warn('No worktreePath for workspace', { workspaceId: input.workspaceId });
        return { files: [], hasWorktree: false };
      }

      const { worktreePath } = result;

      try {
        const files = await searchFilesRecursive(worktreePath, {
          query: input.query,
          limit: input.limit,
          match: input.match,
          signal,
        });

        logger.info('listAllFiles returning files', {
          workspaceId: input.workspaceId,
          query: input.query,
          totalFiles: files.length,
        });

        return { files, hasWorktree: true };
      } catch (error) {
        if (!signal?.aborted) {
          logger.error('listAllFiles error', toError(error), {
            workspaceId: input.workspaceId,
          });
        }
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
      const result = await getWorkspaceWithWorktree(
        ctx.appContext.services.workspaceDataService,
        input.workspaceId
      );

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
        logger.error('listFiles error', toError(error), {
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
    .query(async ({ ctx, input }) => {
      if (input.path.startsWith('/')) {
        await getWorkspaceWorktreeContextOrThrow(
          ctx.appContext.services.workspaceDataService,
          input.workspaceId
        );
        return previewTemporaryFile(input.path);
      }

      const { worktreePath } = await getWorkspaceWithWorktreeOrThrow(
        ctx.appContext.services.workspaceDataService,
        input.workspaceId
      );

      // Validate path is safe
      if (!(await isPathSafe(worktreePath, input.path))) {
        throw new Error('Invalid file path');
      }

      const fullPath = path.join(worktreePath, input.path);

      return previewFile(fullPath, input.path);
    }),

  // List screenshots in .factory-factory/screenshots/
  listScreenshots: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const result = await getWorkspaceWithWorktree(
        ctx.appContext.services.workspaceDataService,
        input.workspaceId
      );
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
    .query(async ({ ctx, input }) => {
      const { fullPath } = await validateScreenshotPath(
        ctx.appContext.services.workspaceDataService,
        input.workspaceId,
        input.path
      );
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
    .mutation(async ({ ctx, input }) => {
      const { fullPath, worktreePath } = await validateScreenshotPath(
        ctx.appContext.services.workspaceDataService,
        input.workspaceId,
        input.path
      );
      await unlink(fullPath);
      ctx.appContext.services.workspaceGitStateService.invalidate(worktreePath);
      return { success: true };
    }),
});
