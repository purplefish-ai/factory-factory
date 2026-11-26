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
  if (path.isAbsolute(linkTarget)) {
    return linkTarget;
  }

  // The kernel resolves a relative target from the link's physical parent, and
  // `..` after a symlinked component climbs from that component's target.
  // Resolve against the parent's real path and keep the target unnormalized so
  // later realpath/lstat calls apply `..` physically instead of lexically.
  const realParentPath = await realpath(path.dirname(candidatePath));
  return realParentPath.endsWith(path.sep)
    ? `${realParentPath}${linkTarget}`
    : `${realParentPath}${path.sep}${linkTarget}`;
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

export interface SearchFilesRecursiveOptions {
  query?: string;
  limit?: number;
  maxDepth?: number;
  ignorePatterns?: string[];
  match?: 'fuzzy';
  signal?: AbortSignal;
}

interface PendingSearchDirectory {
  relativePath: string;
  depth: number;
}

const readSortedSearchDirents = async (directoryPath: string) => {
  try {
    const dirents = await readdir(directoryPath, { withFileTypes: true });
    return dirents.sort((a, b) => a.name.localeCompare(b.name));
  } catch (_error) {
    return [];
  }
};

function fuzzyFilenameRank(name: string, query: string): number | undefined {
  const filename = name.toLowerCase();
  if (filename === query) {
    return 0;
  }
  if (filename.startsWith(query)) {
    return 1;
  }
  if (filename.includes(query)) {
    return 2;
  }
  let position = 0;
  for (const character of query) {
    const found = filename.indexOf(character, position);
    if (found === -1) {
      return undefined;
    }
    position = found + character.length;
  }
  return 3;
}

/**
 * Visit shallow paths first. Returning true from the visitor stops traversal.
 */
async function walkSearchFiles(
  rootPath: string,
  {
    maxDepth = 10,
    ignorePatterns = DEFAULT_FILE_IGNORE_PATTERNS,
    signal,
  }: SearchFilesRecursiveOptions,
  includeHidden: boolean,
  visit: (filePath: string, name: string) => boolean
): Promise<void> {
  const directories: PendingSearchDirectory[] = [{ relativePath: '', depth: 0 }];
  const ignoredNames = new Set(ignorePatterns);
  for (const { relativePath, depth } of directories) {
    signal?.throwIfAborted();
    if (depth >= maxDepth) {
      continue;
    }

    const fullPath = path.join(rootPath, relativePath);
    const dirents = (await readSortedSearchDirents(fullPath)).filter(
      ({ name }) => !ignoredNames.has(name) && (includeHidden || !name.startsWith('.'))
    );

    for (const dirent of dirents) {
      const filePath = relativePath ? path.join(relativePath, dirent.name) : dirent.name;
      if (dirent.isDirectory()) {
        directories.push({ relativePath: filePath, depth: depth + 1 });
      } else if (visit(filePath, dirent.name)) {
        return;
      }
    }
  }
}

async function searchFuzzyFilenames(
  rootPath: string,
  options: SearchFilesRecursiveOptions,
  query: string,
  limit: number
): Promise<string[]> {
  // Cap each tier independently so early weak matches leave room for stronger ones.
  const rankedFiles = new Map<number, string[]>();
  await walkSearchFiles(rootPath, options, true, (filePath, name) => {
    const rank = fuzzyFilenameRank(name, query);
    if (rank === undefined) {
      return false;
    }
    let matches = rankedFiles.get(rank);
    if (!matches) {
      matches = [];
      rankedFiles.set(rank, matches);
    }
    if (matches.length < limit) {
      matches.push(filePath);
    }
    return rank === 0 && matches.length >= limit;
  });

  return [...rankedFiles.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, paths]) => paths.sort((a, b) => compareFilesByRelevance(a, b)))
    .slice(0, limit);
}

/** Recursively searches files with a bounded result set. */
export async function searchFilesRecursive(
  rootPath: string,
  options: SearchFilesRecursiveOptions = {}
): Promise<string[]> {
  const { query, limit = 50, match } = options;
  if (limit <= 0) {
    return [];
  }
  const queryLower = query?.toLowerCase();
  const fuzzyQuery = match === 'fuzzy' ? queryLower?.trim() : undefined;
  if (fuzzyQuery) {
    return searchFuzzyFilenames(rootPath, options, fuzzyQuery, limit);
  }

  const files: string[] = [];
  await walkSearchFiles(rootPath, options, false, (filePath) => {
    if (!queryLower || filePath.toLowerCase().includes(queryLower)) {
      files.push(filePath);
    }
    return files.length >= limit;
  });
  return files.sort((a, b) => compareFilesByRelevance(a, b, queryLower));
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
