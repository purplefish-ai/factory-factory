import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { LIB_LIMITS } from './constants';

/**
 * Represents a file or directory entry in a workspace.
 */
export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Maximum file size to read (1MB).
 */
export const MAX_FILE_SIZE = LIB_LIMITS.maxFileReadBytes;

/**
 * Validate that a file path doesn't escape the worktree directory.
 * Uses path normalization and realpath to handle encoded sequences,
 * symlinks, and other bypass attempts.
 */
export async function isPathSafe(worktreePath: string, filePath: string): Promise<boolean> {
  // Normalize the file path first to handle encoded sequences and resolve ./ etc
  const normalizedPath = path.normalize(filePath);

  // Check for path traversal attempts after normalization
  if (
    normalizedPath.startsWith('..') ||
    normalizedPath.includes(`${path.sep}..${path.sep}`) ||
    normalizedPath.includes(`${path.sep}..`) ||
    normalizedPath.startsWith(path.sep)
  ) {
    return false;
  }

  // Resolve the full path and ensure it's within the worktree
  const fullPath = path.resolve(worktreePath, normalizedPath);
  const normalizedWorktree = path.resolve(worktreePath);

  // Initial check before file exists
  if (!fullPath.startsWith(normalizedWorktree + path.sep) && fullPath !== normalizedWorktree) {
    return false;
  }

  const isWithinPath = (targetPath: string, rootPath: string) =>
    targetPath === rootPath || targetPath.startsWith(rootPath + path.sep);

  const resolveNearestExistingPath = async (targetPath: string): Promise<string> => {
    let candidatePath = targetPath;

    while (true) {
      try {
        return await realpath(candidatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }

        const parentPath = path.dirname(candidatePath);
        if (parentPath === candidatePath) {
          throw error;
        }
        candidatePath = parentPath;
      }
    }
  };

  // Resolve symlinks and verify the path (or nearest existing parent) stays within worktree.
  try {
    const realWorktree = await realpath(normalizedWorktree);
    const realTargetPath = await resolveNearestExistingPath(fullPath);
    return isWithinPath(realTargetPath, realWorktree);
  } catch {
    return false;
  }
}

/**
 * Check if content is binary by looking for null bytes
 */
export function isBinaryContent(buffer: Buffer): boolean {
  // Check first 8KB for null bytes
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}
