/**
 * Shared diff parsing utilities
 */

import type { DiffFile, DiffHunk, DiffLine } from './types';

/**
 * Checks if a line is a diff header (metadata line).
 */
function isHeaderLine(line: string): boolean {
  return (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file')
  );
}

/**
 * Parses a hunk header line and extracts starting line numbers.
 * Returns null if the line is not a valid hunk header.
 */
function parseHunkHeader(line: string): { oldLine: number; newLine: number } | null {
  const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) {
    return null;
  }
  return {
    oldLine: Number.parseInt(match[1] as string, 10),
    newLine: Number.parseInt(match[2] as string, 10),
  };
}

/**
 * Creates a diff line object for an addition.
 */
function createAdditionLine(line: string, newLine: number): DiffLine {
  return {
    type: 'addition',
    content: line.slice(1),
    lineNumber: { new: newLine },
  };
}

/**
 * Creates a diff line object for a deletion.
 */
function createDeletionLine(line: string, oldLine: number): DiffLine {
  return {
    type: 'deletion',
    content: line.slice(1),
    lineNumber: { old: oldLine },
  };
}

/**
 * Creates a diff line object for a context line.
 */
function createContextLine(line: string, oldLine: number, newLine: number): DiffLine {
  return {
    type: 'context',
    content: line.slice(1) || '',
    lineNumber: { old: oldLine, new: newLine },
  };
}

/**
 * Parse a unified diff into detailed line-by-line format with line numbers.
 * Used by the workspace diff viewer for precise line-level navigation.
 *
 * @param diff - Unified diff string
 * @returns Array of parsed diff lines with line number tracking
 */
export function parseDetailedDiff(diff: string): DiffLine[] {
  const lines = diff.split('\n');
  const result: DiffLine[] = [];

  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (isHeaderLine(line)) {
      result.push({ type: 'header', content: line });
      inHunk = false;
    } else if (line.startsWith('@@')) {
      const hunkInfo = parseHunkHeader(line);
      if (hunkInfo) {
        oldLine = hunkInfo.oldLine;
        newLine = hunkInfo.newLine;
        inHunk = true;
      }
      result.push({ type: 'hunk', content: line });
    } else if (inHunk && line.startsWith('+')) {
      result.push(createAdditionLine(line, newLine++));
    } else if (inHunk && line.startsWith('-')) {
      result.push(createDeletionLine(line, oldLine++));
    } else if (inHunk && (line.startsWith(' ') || line === '')) {
      result.push(createContextLine(line, oldLine++, newLine++));
    }
  }

  return result;
}

/**
 * Parse a unified diff into file-based format with hunks.
 * Used by the PR detail panel for displaying changes by file.
 *
 * @param diff - Unified diff string
 * @returns Array of parsed diff files with hunks and statistics
 */
export function parseFileDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split('\n');
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        files.push(currentFile);
      }
      const match = line.match(/b\/(.+)$/);
      currentFile = {
        name: match?.[1] || 'unknown',
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      currentHunk = null;
    } else if (line.startsWith('@@') && currentFile) {
      currentHunk = { header: line, lines: [] };
      currentFile.hunks.push(currentHunk);
    } else if (currentHunk && currentFile) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.lines.push({ type: 'add', content: line.slice(1) });
        currentFile.additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.lines.push({ type: 'del', content: line.slice(1) });
        currentFile.deletions++;
      } else if (line.startsWith(' ')) {
        // Only treat space-prefixed lines as context lines
        currentHunk.lines.push({
          type: 'context',
          content: line.slice(1),
        });
      } else if (line === '') {
        // Empty lines are treated as context
        currentHunk.lines.push({
          type: 'context',
          content: '',
        });
      }
      // Skip other lines (e.g. "\ No newline", metadata) - they are not rendered
    }
  }

  if (currentFile) {
    files.push(currentFile);
  }
  return files;
}

/**
 * Calculate the maximum line number width needed for display.
 * Returns at least 3 characters for proper alignment.
 *
 * @param lines - Array of parsed diff lines
 * @returns Width in characters needed for line numbers
 */
export function calculateLineNumberWidth(lines: DiffLine[]): number {
  let maxLineNumber = 0;
  for (const line of lines) {
    if (line.lineNumber?.old && line.lineNumber.old > maxLineNumber) {
      maxLineNumber = line.lineNumber.old;
    }
    if (line.lineNumber?.new && line.lineNumber.new > maxLineNumber) {
      maxLineNumber = line.lineNumber.new;
    }
  }
  return Math.max(3, String(maxLineNumber).length);
}
