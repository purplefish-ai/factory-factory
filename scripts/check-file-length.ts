import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

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

export type BaselineUpdatePlan =
  | { ok: true; baseline: FileLengthBaseline }
  | { ok: false; blockingViolations: FileLengthViolation[] };

type FileLengthOutput = (message: string) => void;

export type FileLengthCliOptions = {
  repositoryRoot?: string;
  baselinePath?: string;
  args?: readonly string[];
  stdout?: FileLengthOutput;
  stderr?: FileLengthOutput;
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

function isSafeRepositoryRelativeCandidatePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith('/') &&
    !relativePath.includes('\\') &&
    relativePath
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    isFileLengthCandidate(relativePath)
  );
}

const fileLengthBaselineSchema = z.record(
  z.string().refine(isSafeRepositoryRelativeCandidatePath, {
    message: 'Baseline paths must be safe repository-relative candidate paths.',
  }),
  z.number().int().gt(defaultMaxLines)
);

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

export function planBaselineUpdate(evaluation: FileLengthEvaluation): BaselineUpdatePlan {
  const blockingViolations = evaluation.violations.filter(
    (violation) => violation.kind === 'grew' || violation.kind === 'new-oversized'
  );

  if (blockingViolations.length > 0) {
    return { ok: false, blockingViolations };
  }

  return {
    ok: true,
    baseline: Object.fromEntries(
      evaluation.currentOversized
        .toSorted((left, right) => left.path.localeCompare(right.path))
        .map((file) => [file.path, file.lines])
    ),
  };
}

export function discoverCandidatePaths(repositoryRoot: string): string[] {
  const gitOutput = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );

  return gitOutput
    .split('\0')
    .filter((path) => path.length > 0)
    .map((path) => path.replace(/^\.\/+/, ''))
    .filter(isSafeRepositoryRelativeCandidatePath)
    .toSorted((left, right) => left.localeCompare(right));
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function readFileLengths(repositoryRoot: string, paths: readonly string[]): FileLength[] {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const realRepositoryRoot = realpathSync(resolvedRepositoryRoot);

  return paths.flatMap((relativePath) => {
    if (!isSafeRepositoryRelativeCandidatePath(relativePath)) {
      throw new Error(`Unsafe file length candidate path: ${relativePath}`);
    }

    const absolutePath = resolve(resolvedRepositoryRoot, relativePath);
    let realPath: string;
    try {
      realPath = realpathSync(absolutePath);
    } catch (error) {
      if (isMissingPathError(error)) {
        return [];
      }
      throw error;
    }
    const pathFromRepositoryRoot = relative(realRepositoryRoot, realPath);
    if (
      pathFromRepositoryRoot === '..' ||
      pathFromRepositoryRoot.startsWith(`..${sep}`) ||
      pathFromRepositoryRoot.startsWith('/')
    ) {
      throw new Error(`File length candidate path escapes repository root: ${relativePath}`);
    }
    if (!statSync(realPath).isFile()) {
      throw new Error(`File length candidate path is not a regular file: ${relativePath}`);
    }

    return [{ path: relativePath, lines: countPhysicalLines(readFileSync(realPath, 'utf8')) }];
  });
}

function readFileLengthBaseline(baselinePath: string): FileLengthBaseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid file length baseline: ${message}`);
  }

  const result = fileLengthBaselineSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid file length baseline: ${result.error.issues.map((issue) => issue.message).join(' ')}`
    );
  }

  return result.data;
}

function serializeFileLengthBaseline(baseline: FileLengthBaseline): string {
  const sortedBaseline = Object.fromEntries(
    Object.entries(baseline).toSorted(([left], [right]) => left.localeCompare(right))
  );
  return `${JSON.stringify(sortedBaseline, null, 2)}\n`;
}

function writeFileLengthBaseline(baselinePath: string, baseline: FileLengthBaseline): void {
  const temporaryPath = join(
    dirname(baselinePath),
    `.${basename(baselinePath)}.${randomUUID()}.tmp`
  );
  writeFileSync(temporaryPath, serializeFileLengthBaseline(baseline));

  try {
    renameSync(temporaryPath, baselinePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The rename may have moved the temporary file despite reporting an error.
    }
    throw error;
  }
}

export function formatFileLengthViolations(violations: readonly FileLengthViolation[]): string {
  return violations
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map((violation) => {
      switch (violation.kind) {
        case 'new-oversized':
          return `${violation.path}: ${violation.currentLines} lines exceeds the allowed ${violation.maxLines}; reduce it to ${violation.maxLines} lines or fewer.`;
        case 'grew':
          return `${violation.path}: ${violation.currentLines} lines exceeds the recorded ${violation.baselineLines}; reduce it to ${violation.baselineLines} lines or fewer.`;
        case 'baseline-stale':
          return `${violation.path}: ${violation.currentLines} lines is below the recorded ${violation.baselineLines}; run with --update to lower the baseline.`;
        case 'baseline-missing':
          return `${violation.path}: no longer exists but has a recorded ${violation.baselineLines}-line baseline; run with --update to remove it.`;
      }
    })
    .join('\n');
}

function writeCliError(stderr: FileLengthOutput, prefix: string, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  stderr(`${prefix}${message}\n`);
  return 1;
}

function readBaselineForCli(
  baselinePath: string,
  stderr: FileLengthOutput
): FileLengthBaseline | undefined {
  try {
    return readFileLengthBaseline(baselinePath);
  } catch (error) {
    writeCliError(stderr, '', error);
    return undefined;
  }
}

function readFilesForCli(
  repositoryRoot: string,
  stderr: FileLengthOutput
): FileLength[] | undefined {
  try {
    return readFileLengths(repositoryRoot, discoverCandidatePaths(repositoryRoot));
  } catch (error) {
    writeCliError(stderr, 'Unable to discover file length candidates: ', error);
    return undefined;
  }
}

function parseUpdateMode(args: readonly string[], stderr: FileLengthOutput): boolean | undefined {
  if (args.length === 0) {
    return false;
  }
  if (args.length === 1 && args[0] === '--update') {
    return true;
  }

  stderr('Usage: check-file-length.ts [--update]\n');
  return undefined;
}

function runNormalFileLengthCli(
  evaluation: FileLengthEvaluation,
  stdout: FileLengthOutput,
  stderr: FileLengthOutput
): number {
  if (evaluation.violations.length > 0) {
    stderr(`${formatFileLengthViolations(evaluation.violations)}\n`);
    return 1;
  }

  stdout('File length check passed.\n');
  return 0;
}

function runUpdateFileLengthCli(
  evaluation: FileLengthEvaluation,
  baselinePath: string,
  stdout: FileLengthOutput,
  stderr: FileLengthOutput
): number {
  const updatePlan = planBaselineUpdate(evaluation);
  if (!updatePlan.ok) {
    stderr(`${formatFileLengthViolations(updatePlan.blockingViolations)}\n`);
    return 1;
  }

  try {
    writeFileLengthBaseline(baselinePath, updatePlan.baseline);
  } catch (error) {
    return writeCliError(stderr, 'Unable to update file length baseline: ', error);
  }

  stdout('Updated file length baseline.\n');
  return 0;
}

export function runFileLengthCli(options: FileLengthCliOptions = {}): number {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const baselinePath =
    options.baselinePath ?? join(repositoryRoot, 'scripts/file-length-baseline.json');
  const args = options.args ?? process.argv.slice(2);
  const stdout = options.stdout ?? ((message: string) => process.stdout.write(message));
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(message));
  const updateMode = parseUpdateMode(args, stderr);

  if (updateMode === undefined) {
    return 1;
  }

  const baseline = readBaselineForCli(baselinePath, stderr);
  if (baseline === undefined) {
    return 1;
  }

  const files = readFilesForCli(repositoryRoot, stderr);
  if (files === undefined) {
    return 1;
  }

  const evaluation = evaluateFileLengths(files, baseline);
  return updateMode
    ? runUpdateFileLengthCli(evaluation, baselinePath, stdout, stderr)
    : runNormalFileLengthCli(evaluation, stdout, stderr);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runFileLengthCli();
}
