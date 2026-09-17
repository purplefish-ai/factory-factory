/**
 * Which (path, side, line) triples a unified diff actually allows an inline
 * PR comment on. GitHub rejects an inline comment on a line outside the
 * diff's hunks, and the reviewer model sometimes points at a nearby
 * unmodified line it read for context but that isn't part of this diff.
 */

const FILE_HEADER_PATTERN = /^\+\+\+ b\/(.+)$/;
const NEW_FILE_HEADER_PATTERN = /^\+\+\+ \/dev\/null$/;
const OLD_FILE_HEADER_PATTERN = /^--- /;
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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

/** Match a diff-metadata line (file/hunk header), returning what it means to update. */
function matchDiffMetadataLine(
  rawLine: string
): { kind: 'file'; path: string | null } | { kind: 'hunk'; cursor: HunkCursor } | null {
  const fileHeaderMatch = rawLine.match(FILE_HEADER_PATTERN);
  if (fileHeaderMatch?.[1]) {
    return { kind: 'file', path: fileHeaderMatch[1] };
  }
  if (NEW_FILE_HEADER_PATTERN.test(rawLine)) {
    return { kind: 'file', path: null };
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

/** Parse a unified diff (as produced by `gh pr diff`) into a line index. */
export function buildDiffLineIndex(diff: string): DiffLineIndex {
  const index = new DiffLineIndex();
  let currentPath: string | null = null;
  let cursor: HunkCursor = { oldLine: 0, newLine: 0 };

  for (const rawLine of diff.split('\n')) {
    if (OLD_FILE_HEADER_PATTERN.test(rawLine)) {
      continue;
    }

    const metadata = matchDiffMetadataLine(rawLine);
    if (metadata?.kind === 'file') {
      currentPath = metadata.path;
      continue;
    }
    if (metadata?.kind === 'hunk') {
      cursor = metadata.cursor;
      continue;
    }

    if (!currentPath || rawLine.length === 0) {
      continue;
    }

    cursor = indexContentLine(index, currentPath, rawLine, cursor);
  }

  return index;
}
