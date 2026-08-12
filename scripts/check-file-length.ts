const candidateRoots = new Set(['src', 'electron', 'scripts']);
const candidateExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '.cts']);

const defaultMaxLines = 1000;

export type FileLength = {
  path: string;
  lines: number;
};

export type FileLengthBaseline = Record<string, number>;

export type FileLengthViolation =
  | { kind: 'new-oversized'; path: string; currentLines: number; maxLines: number }
  | { kind: 'grew'; path: string; currentLines: number; baselineLines: number }
  | { kind: 'baseline-stale'; path: string; currentLines: number; baselineLines: number }
  | { kind: 'baseline-missing'; path: string; baselineLines: number };

export type FileLengthEvaluation = {
  violations: FileLengthViolation[];
  currentOversized: FileLength[];
};

export function countPhysicalLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const terminators = content.match(/\r\n|\r|\n/g)?.length ?? 0;
  return terminators + (/(?:\r\n|\r|\n)$/.test(content) ? 0 : 1);
}

export function isFileLengthCandidate(relativePath: string): boolean {
  const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const [root] = normalizedPath.split('/');
  const extensionStart = normalizedPath.lastIndexOf('.');
  const extension = extensionStart === -1 ? '' : normalizedPath.slice(extensionStart);

  return root !== undefined && candidateRoots.has(root) && candidateExtensions.has(extension);
}

export function evaluateFileLengths(
  files: readonly FileLength[],
  baseline: FileLengthBaseline,
  maxLines = defaultMaxLines
): FileLengthEvaluation {
  const currentPaths = new Set(files.map((file) => file.path));
  const currentOversized = files
    .filter((file) => file.lines > maxLines)
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const violations: FileLengthViolation[] = [];

  for (const file of files) {
    const baselineLines = baseline[file.path];

    if (baselineLines === undefined) {
      if (file.lines > maxLines) {
        violations.push({
          kind: 'new-oversized',
          path: file.path,
          currentLines: file.lines,
          maxLines,
        });
      }
      continue;
    }

    if (file.lines > baselineLines) {
      violations.push({
        kind: 'grew',
        path: file.path,
        currentLines: file.lines,
        baselineLines,
      });
    } else if (file.lines < baselineLines) {
      violations.push({
        kind: 'baseline-stale',
        path: file.path,
        currentLines: file.lines,
        baselineLines,
      });
    }
  }

  for (const [path, baselineLines] of Object.entries(baseline)) {
    if (!currentPaths.has(path)) {
      violations.push({ kind: 'baseline-missing', path, baselineLines });
    }
  }

  return {
    violations: violations.toSorted((left, right) => left.path.localeCompare(right.path)),
    currentOversized,
  };
}
