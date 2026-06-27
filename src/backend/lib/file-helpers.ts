import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
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

const isErrnoCode = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException).code === code;

const isWithinPath = (targetPath: string, rootPath: string): boolean =>
  targetPath === rootPath || targetPath.startsWith(rootPath + path.sep);

const DEFAULT_FILE_IGNORE_PATTERNS = [
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

const shouldIgnoreFileSearchEntry = (name: string, ignorePatterns: string[]): boolean =>
  ignorePatterns.includes(name) || name.startsWith('.');

const resolveSymlinkTargetPath = async (candidatePath: string): Promise<string | null> => {
  let candidateStats: Awaited<ReturnType<typeof lstat>>;

  try {
    candidateStats = await lstat(candidatePath);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }

  if (!candidateStats.isSymbolicLink()) {
    return null;
  }

  const linkTarget = await readlink(candidatePath);
  return path.resolve(path.dirname(candidatePath), linkTarget);
};

const resolveParentPath = (candidatePath: string, error: unknown): string => {
  const parentPath = path.dirname(candidatePath);
  if (parentPath === candidatePath) {
    throw error;
  }
  return parentPath;
};

const resolveNearestExistingPath = async (targetPath: string): Promise<string> => {
  let candidatePath = targetPath;
  const visitedPaths = new Set<string>();

  while (true) {
    if (visitedPaths.has(candidatePath)) {
      throw new Error(`Detected symlink resolution loop for path: ${candidatePath}`);
    }
    visitedPaths.add(candidatePath);

    try {
      return await realpath(candidatePath);
    } catch (error) {
      if (!isErrnoCode(error, 'ENOENT')) {
        throw error;
      }

      const symlinkTargetPath = await resolveSymlinkTargetPath(candidatePath);
      candidatePath = symlinkTargetPath ?? resolveParentPath(candidatePath, error);
    }
  }
};

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

  try {
    const dirents = await readdir(fullPath, { withFileTypes: true });

    for (const dirent of dirents) {
      if (shouldIgnoreFileSearchEntry(dirent.name, DEFAULT_FILE_IGNORE_PATTERNS)) {
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

export interface SearchFilesRecursiveOptions {
  query?: string;
  limit?: number;
  maxDepth?: number;
  ignorePatterns?: string[];
}

interface PendingSearchDirectory {
  relativePath: string;
  depth: number;
}

interface FileSearchTraversalState {
  directories: PendingSearchDirectory[];
  files: string[];
  ignorePatterns: string[];
  limit: number;
  queryLower: string | undefined;
}

const readSortedSearchDirents = async (directoryPath: string) => {
  try {
    const dirents = await readdir(directoryPath, { withFileTypes: true });
    return dirents.sort((a, b) => a.name.localeCompare(b.name));
  } catch (_error) {
    return [];
  }
};

const sortFileSearchResults = (files: string[], queryLower?: string): string[] =>
  files.sort((a, b) => compareFilesByRelevance(a, b, queryLower));

const matchesFileSearchQuery = (filePath: string, queryLower?: string): boolean =>
  !queryLower || filePath.toLowerCase().includes(queryLower);

type SearchDirent = Awaited<ReturnType<typeof readSortedSearchDirents>>[number];

const collectFileSearchEntry = (
  state: FileSearchTraversalState,
  dirent: SearchDirent,
  relativePath: string,
  depth: number
): boolean => {
  if (shouldIgnoreFileSearchEntry(dirent.name, state.ignorePatterns)) {
    return false;
  }

  const filePath = relativePath ? path.join(relativePath, dirent.name) : dirent.name;

  if (dirent.isDirectory()) {
    state.directories.push({ relativePath: filePath, depth: depth + 1 });
    return false;
  }

  if (!matchesFileSearchQuery(filePath, state.queryLower)) {
    return false;
  }

  state.files.push(filePath);
  return state.files.length >= state.limit;
};

/**
 * Recursively searches files with a bounded result set for autocomplete.
 * Traversal is breadth-first and deterministic so shallow paths are considered
 * before deep paths, then the bounded candidates are relevance-sorted.
 */
export async function searchFilesRecursive(
  rootPath: string,
  {
    query,
    limit = 50,
    maxDepth = 10,
    ignorePatterns = DEFAULT_FILE_IGNORE_PATTERNS,
  }: SearchFilesRecursiveOptions = {}
): Promise<string[]> {
  if (limit <= 0) {
    return [];
  }

  const queryLower = query?.toLowerCase();
  const state: FileSearchTraversalState = {
    directories: [{ relativePath: '', depth: 0 }],
    files: [],
    ignorePatterns,
    limit,
    queryLower,
  };

  for (const { relativePath, depth } of state.directories) {
    if (depth >= maxDepth) {
      continue;
    }

    const fullPath = path.join(rootPath, relativePath);
    const dirents = await readSortedSearchDirents(fullPath);

    for (const dirent of dirents) {
      if (collectFileSearchEntry(state, dirent, relativePath, depth)) {
        return sortFileSearchResults(state.files, queryLower);
      }
    }
  }

  return sortFileSearchResults(state.files, queryLower);
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
