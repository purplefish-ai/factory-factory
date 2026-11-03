import { realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readFilePrefix } from '@/backend/lib/file-preview';
import { publicProcedure, router } from '@/backend/trpc/trpc';
import { MAX_IMAGE_SIZE } from '@/shared/attachment-limits';
import { getWorkspaceWithWorktreeOrThrow } from './workspace-helpers';

function imageMimeType(buffer: Buffer): string | null {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) {
    return 'image/jpeg';
  }
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export const workspaceChatImagesRouter = router({
  // Use the existing workspace file-query boundary; never expose an arbitrary
  // filesystem URL to the browser. Temporary files support agent mockups.
  readChatImage: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string().min(1).max(4096) }))
    .query(async ({ ctx, input }) => {
      const { worktreePath } = await getWorkspaceWithWorktreeOrThrow(
        ctx.appContext.services.workspaceDataService,
        input.workspaceId
      );
      const fullPath = path.resolve(worktreePath, input.path);
      const roots = path.isAbsolute(input.path)
        ? [worktreePath, tmpdir(), ...(path.sep === '/' ? ['/tmp'] : [])]
        : [worktreePath];
      // Resolve once, validate that exact target, and open it without following
      // a replacement final symlink. Include physical OS aliases (/private/tmp).
      const canonicalPath = await realpath(fullPath);
      let safe = false;
      for (const root of roots) {
        const canonicalRoot = await realpath(root);
        if (
          (isWithin(root, fullPath) || isWithin(canonicalRoot, fullPath)) &&
          isWithin(canonicalRoot, canonicalPath)
        ) {
          safe = true;
          break;
        }
      }
      if (!safe) {
        throw new Error('Invalid image path');
      }
      if (!/\.(png|jpe?g|gif|webp)$/i.test(fullPath)) {
        throw new Error('Unsupported image format');
      }
      const { buffer, truncated } = await readFilePrefix(canonicalPath, {
        maxBytes: MAX_IMAGE_SIZE,
        noFollow: true,
        validateFile: async (opened) => {
          const currentPath = await realpath(fullPath);
          if (currentPath !== canonicalPath) {
            throw new Error('Image path changed during preview');
          }
          const current = await stat(currentPath);
          if (
            current.dev !== opened.dev ||
            current.ino !== opened.ino ||
            (await realpath(fullPath)) !== canonicalPath
          ) {
            throw new Error('Image file changed during preview');
          }
        },
      });
      if (truncated) {
        throw new Error('Image exceeds the 10 MB preview limit');
      }
      const mimeType = imageMimeType(buffer);
      if (!mimeType) {
        throw new Error('Unsupported image format');
      }
      return { data: buffer.toString('base64'), mimeType, name: path.basename(fullPath) };
    }),
});
