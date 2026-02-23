import { readdir, realpath, stat } from 'node:fs/promises';
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
 * Recursively list all files in a directory, excluding common ignore patterns.
 */
export async function listFilesRecursive(
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
      if (ignorePatterns.includes(dirent.name)) {
        continue;
      }

      if (dirent.name.startsWith('.')) {
        continue;
      }

      const relativePath = currentPath ? path.join(currentPath, dirent.name) : dirent.name;

      if (dirent.isDirectory()) {
        const subFiles = await listFilesRecursive(
          rootPath,
          relativePath,
          maxDepth,
          currentDepth + 1
        );
        files.push(...subFiles);
      } else {
        files.push(relativePath);
      }
    }
  } catch (_error) {
    return files;
  }

  return files;
}

/**
 * Comparator for sorting files by relevance to a query.
 */
export function compareFilesByRelevance(a: string, b: string, queryLower?: string): number {
  if (queryLower) {
    const aBasename = path.basename(a).toLowerCase();
    const bBasename = path.basename(b).toLowerCase();

    const aExact = aBasename === queryLower;
    const bExact = bBasename === queryLower;
    if (aExact !== bExact) {
      return aExact ? -1 : 1;
    }

    const aStarts = aBasename.startsWith(queryLower);
    const bStarts = bBasename.startsWith(queryLower);
    if (aStarts !== bStarts) {
      return aStarts ? -1 : 1;
    }
  }

  const aDepth = a.split('/').length;
  const bDepth = b.split('/').length;
  if (aDepth !== bDepth) {
    return aDepth - bDepth;
  }

  return a.localeCompare(b);
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
