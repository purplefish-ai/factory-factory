import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Represents a file or directory entry in a workspace.
 */
export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
}

/**
 * Maximum file size to read (1MB).
 */
export const MAX_FILE_SIZE = 1024 * 1024;

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

  // If the file exists, resolve symlinks and verify the real path is still within worktree
  try {
    const realFullPath = await realpath(fullPath);
    const realWorktree = await realpath(normalizedWorktree);
    return realFullPath.startsWith(realWorktree + path.sep) || realFullPath === realWorktree;
  } catch {
    // File doesn't exist yet (e.g., for new file creation) - rely on the initial check
    return true;
  }
}

/**
 * Get language from file extension for syntax highlighting
 */
export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    graphql: 'graphql',
    prisma: 'prisma',
  };
  return langMap[ext ?? ''] ?? 'text';
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
