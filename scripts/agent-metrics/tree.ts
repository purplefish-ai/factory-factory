import { posix } from 'node:path';
import { countPhysicalLines } from '../check-file-length';
import { share } from './statistics';

const mostEditedFileCount = 10;
export const largeFileLines = 900;

export type TreeFile = { path: string; content: string };

function directoryOf(path: string): string {
  const directory = posix.dirname(path);
  return directory === '.' ? '' : directory;
}

function isWithin(directory: string, ancestor: string): boolean {
  return ancestor === '' || directory === ancestor || directory.startsWith(`${ancestor}/`);
}

/** Rough token estimate: four bytes per token. */
export function estimateTokens(content: string): number {
  return Math.round(Buffer.byteLength(content, 'utf8') / 4);
}

export function isGuideFile(path: string): boolean {
  return posix.basename(path) === 'AGENTS.md';
}

export type GuideChain = { directory: string; guides: string[]; lines: number; tokens: number };

/** For each directory with an `AGENTS.md`: that guide plus every ancestor guide. */
export function guideChains(guides: readonly TreeFile[]): GuideChain[] {
  return guides
    .map((guide) => directoryOf(guide.path))
    .toSorted()
    .map((directory) => {
      const chain = guides
        .filter((guide) => isWithin(directory, directoryOf(guide.path)))
        .toSorted((left, right) => left.path.length - right.path.length);
      return {
        directory: directory === '' ? '.' : directory,
        guides: chain.map((guide) => guide.path),
        lines: chain.reduce((total, guide) => total + countPhysicalLines(guide.content), 0),
        tokens: chain.reduce((total, guide) => total + estimateTokens(guide.content), 0),
      };
    });
}

export function isArchitectureNote(path: string): boolean {
  return path.startsWith('docs/architecture/') && path.endsWith('.md');
}

/** Non-test, non-story TypeScript under `src/`. */
export function isProductionSource(path: string): boolean {
  return (
    path.startsWith('src/') &&
    /\.tsx?$/.test(path) &&
    !/\.test\.tsx?$/.test(path) &&
    !/\.stories\.tsx?$/.test(path)
  );
}

export function isSourceTest(path: string): boolean {
  return path.startsWith('src/') && /\.test\.tsx?$/.test(path);
}

export type FileLines = { path: string; lines: number };

export type GuidanceSize = {
  guideLines: number;
  architectureNoteLines: number;
  guidanceLines: number;
  sourceLines: number;
  /** Guidance lines per 1,000 production source lines. */
  guidancePerThousandSourceLines: number | null;
};

export function guidanceSize(
  guides: readonly FileLines[],
  architectureNotes: readonly FileLines[],
  source: readonly FileLines[]
): GuidanceSize {
  const sum = (files: readonly FileLines[]) => files.reduce((total, file) => total + file.lines, 0);
  const guideLines = sum(guides);
  const architectureNoteLines = sum(architectureNotes);
  const sourceLines = sum(source);
  return {
    guideLines,
    architectureNoteLines,
    guidanceLines: guideLines + architectureNoteLines,
    sourceLines,
    guidancePerThousandSourceLines:
      sourceLines === 0
        ? null
        : Number((((guideLines + architectureNoteLines) / sourceLines) * 1000).toFixed(1)),
  };
}

export type EditedFile = { path: string; commits: number; share: number | null };

/** Takes the files touched by each commit, newest first. */
export function mostEditedFiles(
  commits: readonly (readonly string[])[],
  limit = mostEditedFileCount
): EditedFile[] {
  const counts = new Map<string, number>();
  for (const files of commits) {
    for (const path of new Set(files)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return [...counts]
    .toSorted(
      ([leftPath, left], [rightPath, right]) => right - left || leftPath.localeCompare(rightPath)
    )
    .slice(0, limit)
    .map(([path, count]) => ({ path, commits: count, share: share(count, commits.length) }));
}

export function largeFiles(files: readonly FileLines[], threshold = largeFileLines): FileLines[] {
  return files
    .filter((file) => file.lines >= threshold)
    .toSorted((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
}
