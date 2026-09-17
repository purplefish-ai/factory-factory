/**
 * Which (path, side, line) triples a unified diff actually allows an inline
 * PR comment on. GitHub rejects an inline comment on a line outside the
 * diff's hunks, and the reviewer model sometimes points at a nearby
 * unmodified line it read for context but that isn't part of this diff.
 */

const NEW_FILE_HEADER_PATTERN = /^\+\+\+ (?:b\/(.+?)(?:\t.*)?|\/dev\/null(?:\t.*)?)$/;
const OLD_FILE_HEADER_PATTERN = /^--- (?:a\/(.+?)(?:\t.*)?|\/dev\/null(?:\t.*)?)$/;
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const CONTENT_LINE_MARKERS = new Set(['+', '-', ' ', '\\']);

export type DiffCommentSide = 'LEFT' | 'RIGHT';

export class DiffLineIndex {
  private readonly validTargets = new Set<string>();

  private static key(path: string, side: DiffCommentSide, line: number): string {
    return `${path}::${side}::${line}`;
  }

  add(path: string, side: DiffCommentSide, line: number): void {
    this.validTargets.add(DiffLineIndex.key(path, side, line));
  }

  has(path: string, side: DiffCommentSide, line: number): boolean {
    return this.validTargets.has(DiffLineIndex.key(path, side, line));
  }
}

interface HunkCursor {
  oldLine: number;
  newLine: number;
}

/** Index one content line (added/removed/context) and advance the cursor. */
function indexContentLine(
  index: DiffLineIndex,
  path: string,
  rawLine: string,
  cursor: HunkCursor
): HunkCursor {
  const marker = rawLine[0];
  if (marker === '+') {
    index.add(path, 'RIGHT', cursor.newLine);
    return { oldLine: cursor.oldLine, newLine: cursor.newLine + 1 };
  }
  if (marker === '-') {
    index.add(path, 'LEFT', cursor.oldLine);
    return { oldLine: cursor.oldLine + 1, newLine: cursor.newLine };
  }
  if (marker === ' ') {
    // Unchanged context line: commentable on the new-file side.
    index.add(path, 'RIGHT', cursor.newLine);
    return { oldLine: cursor.oldLine + 1, newLine: cursor.newLine + 1 };
  }
  return cursor;
}

/**
 * Match a diff-metadata line (old/new file header, hunk header), returning
 * what it means to update. Only meaningful outside a hunk — content lines
 * inside a hunk always start with a diff marker and are never passed here
 * (see `isHunkContentLine`), so a line that merely resembles one of these
 * patterns (e.g. an added line whose text happens to start with `-- `) can't
 * be misread as metadata.
 */
function matchDiffMetadataLine(
  rawLine: string
):
  | { kind: 'oldFile'; path: string | null }
  | { kind: 'newFile'; path: string | null }
  | { kind: 'hunk'; cursor: HunkCursor }
  | null {
  const oldHeaderMatch = rawLine.match(OLD_FILE_HEADER_PATTERN);
  if (oldHeaderMatch) {
    return { kind: 'oldFile', path: oldHeaderMatch[1] ?? null };
  }
  const newHeaderMatch = rawLine.match(NEW_FILE_HEADER_PATTERN);
  if (newHeaderMatch) {
    return { kind: 'newFile', path: newHeaderMatch[1] ?? null };
  }
  const hunkMatch = rawLine.match(HUNK_HEADER_PATTERN);
  if (hunkMatch?.[1] && hunkMatch[2]) {
    return {
      kind: 'hunk',
      cursor: {
        oldLine: Number.parseInt(hunkMatch[1], 10),
        newLine: Number.parseInt(hunkMatch[2], 10),
      },
    };
  }
  return null;
}

/** Whether a line inside a hunk is unified-diff content rather than the next hunk/file's metadata. */
function isHunkContentLine(rawLine: string): boolean {
  return rawLine.length > 0 && CONTENT_LINE_MARKERS.has(rawLine[0] as string);
}

/** Parse a unified diff (as produced by `gh pr diff`) into a line index. */
export function buildDiffLineIndex(diff: string): DiffLineIndex {
  const index = new DiffLineIndex();
  let currentPath: string | null = null;
  // The old-file path from the most recent "--- " header, kept so a deleted
  // file ("+++ /dev/null") still has a path to index its LEFT-side comments
  // under — the new-file header alone carries no path in that case.
  let pendingOldPath: string | null = null;
  let cursor: HunkCursor = { oldLine: 0, newLine: 0 };
  let inHunk = false;

  for (const rawLine of diff.split('\n')) {
    if (inHunk && isHunkContentLine(rawLine)) {
      if (currentPath) {
        cursor = indexContentLine(index, currentPath, rawLine, cursor);
      }
      continue;
    }
    inHunk = false;

    const metadata = matchDiffMetadataLine(rawLine);
    if (metadata?.kind === 'oldFile') {
      pendingOldPath = metadata.path;
      continue;
    }
    if (metadata?.kind === 'newFile') {
      currentPath = metadata.path ?? pendingOldPath;
      continue;
    }
    if (metadata?.kind === 'hunk') {
      cursor = metadata.cursor;
      inHunk = true;
    }
    // Other metadata lines between files/hunks (e.g. "diff --git", "index …").
  }

  return index;
}
