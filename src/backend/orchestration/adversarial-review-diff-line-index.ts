/**
 * Which (path, side, line) triples a unified diff actually allows an inline
 * PR comment on. GitHub rejects an inline comment on a line outside the
 * diff's hunks, and the reviewer model sometimes points at a nearby
 * unmodified line it read for context but that isn't part of this diff.
 */

import { decodeGitPath } from '@/shared/git-path';

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
 * The repository path named by a `--- `/`+++ ` file header, without its
 * `a/`/`b/` prefix. Git C-quotes paths with special or non-ASCII bytes
 * (`+++ "b/lib/caf\303\251.ts"`), so the header is decoded before the prefix
 * is stripped, yielding the real path reviewers reference. `/dev/null` yields
 * `null`; an unrecognized header yields `undefined`.
 */
function parseFileHeaderPath(header: string, prefix: 'a/' | 'b/'): string | null | undefined {
  // Git appends a tab after unquoted paths containing spaces; quoted paths
  // escape their own tabs, so the first tab always ends the path.
  const rawPath = header.split('\t')[0] ?? '';
  if (rawPath === '/dev/null') {
    return null;
  }
  const path = decodeGitPath(rawPath);
  return path.startsWith(prefix) && path.length > prefix.length
    ? path.slice(prefix.length)
    : undefined;
}

/**
 * Match a diff-metadata line (file start, old/new file header, hunk header),
 * returning what it means to update. Only meaningful outside a hunk — content lines
 * inside a hunk always start with a diff marker and are never passed here
 * (see `isHunkContentLine`), so a line that merely resembles one of these
 * patterns (e.g. an added line whose text happens to start with `-- `) can't
 * be misread as metadata.
 */
function matchDiffMetadataLine(
  rawLine: string
):
  | { kind: 'fileStart' }
  | { kind: 'oldFile'; path: string | null | undefined }
  | { kind: 'newFile'; path: string | null | undefined }
  | { kind: 'hunk'; cursor: HunkCursor }
  | null {
  if (rawLine.startsWith('diff --git ')) {
    return { kind: 'fileStart' };
  }
  if (rawLine.startsWith('--- ')) {
    return { kind: 'oldFile', path: parseFileHeaderPath(rawLine.slice(4), 'a/') };
  }
  if (rawLine.startsWith('+++ ')) {
    return { kind: 'newFile', path: parseFileHeaderPath(rawLine.slice(4), 'b/') };
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

interface FilePaths {
  /** The path hunk lines are indexed under, or null to skip them. */
  current: string | null;
  /**
   * The old-file path from the most recent "--- " header, kept so a deleted
   * file ("+++ /dev/null") still has a path to index its LEFT-side comments
   * under — the new-file header alone carries no path in that case.
   */
  pendingOld: string | null;
}

/** Apply a file-level metadata line to the paths hunk lines are indexed under. */
function applyFileHeader(
  paths: FilePaths,
  metadata: { kind: 'fileStart' } | { kind: 'oldFile' | 'newFile'; path: string | null | undefined }
): FilePaths {
  if (metadata.kind === 'fileStart') {
    // A new file section: never let its hunks inherit the previous file's
    // path, even if its headers turn out to be missing or unrecognized.
    return { current: null, pendingOld: null };
  }
  if (metadata.kind === 'oldFile') {
    return { current: paths.current, pendingOld: metadata.path ?? null };
  }
  // `null` is /dev/null (a deleted file); `undefined` is a header that could
  // not be parsed, whose hunks are skipped rather than misattributed.
  return {
    current: metadata.path === null ? paths.pendingOld : (metadata.path ?? null),
    pendingOld: paths.pendingOld,
  };
}

/** Parse a unified diff (as produced by `gh pr diff`) into a line index. */
export function buildDiffLineIndex(diff: string): DiffLineIndex {
  const index = new DiffLineIndex();
  let paths: FilePaths = { current: null, pendingOld: null };
  let cursor: HunkCursor = { oldLine: 0, newLine: 0 };
  let inHunk = false;

  for (const rawLine of diff.split('\n')) {
    if (inHunk && isHunkContentLine(rawLine)) {
      if (paths.current) {
        cursor = indexContentLine(index, paths.current, rawLine, cursor);
      }
      continue;
    }
    inHunk = false;

    const metadata = matchDiffMetadataLine(rawLine);
    if (metadata?.kind === 'hunk') {
      cursor = metadata.cursor;
      inHunk = true;
    } else if (metadata) {
      paths = applyFileHeader(paths, metadata);
    }
    // Other metadata lines between files/hunks (e.g. "index …", "new file mode").
  }

  return index;
}
