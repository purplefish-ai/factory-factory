import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  countPhysicalLines,
  discoverCandidatePaths,
  evaluateFileLengths,
  type FileLength,
  formatFileLengthViolations,
  isFileLengthCandidate,
  planBaselineUpdate,
  readFileLengths,
  runFileLengthCli,
} from './check-file-length';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTemporaryRepository(): string {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'file-length-ratchet-'));
  temporaryDirectories.push(repositoryRoot);
  execFileSync('git', ['init'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.name', 'File Length Test'], { cwd: repositoryRoot });
  mkdirSync(join(repositoryRoot, 'docs'));
  mkdirSync(join(repositoryRoot, 'src'));
  return repositoryRoot;
}

function writeLines(filePath: string, lines: number): void {
  writeFileSync(filePath, `${'line\n'.repeat(lines)}`);
}

describe('countPhysicalLines', () => {
  test.each([
    ['a\n', 1],
    ['a\r\n', 1],
    ['a\nb', 2],
    ['a\r\nb\r\n', 2],
    ['a\rb\r', 2],
    ['', 0],
  ])('counts physical lines without a phantom final line', (content, expected) => {
    expect(countPhysicalLines(content)).toBe(expected);
  });
});

describe('isFileLengthCandidate', () => {
  test.each([
    'src/a.ts',
    'src/a.test.tsx',
    'electron/main.mts',
    'scripts/check.mjs',
  ])('includes %s', (file) => expect(isFileLengthCandidate(file)).toBe(true));

  test.each([
    'prisma/generated/a.ts',
    'docs/a.ts',
    'src/a.json',
    'dist/a.ts',
  ])('excludes %s', (file) => expect(isFileLengthCandidate(file)).toBe(false));
});

describe('evaluateFileLengths', () => {
  test('reports a new oversized file', () => {
    const files: FileLength[] = [{ path: 'src/new.ts', lines: 1001 }];

    expect(evaluateFileLengths(files, {})).toMatchObject({
      violations: [{ kind: 'new-oversized', path: 'src/new.ts', currentLines: 1001 }],
    });
  });

  test('reports a baseline file that grew', () => {
    const files: FileLength[] = [{ path: 'src/legacy.ts', lines: 1201 }];

    expect(evaluateFileLengths(files, { 'src/legacy.ts': 1200 })).toMatchObject({
      violations: [
        { kind: 'grew', path: 'src/legacy.ts', currentLines: 1201, baselineLines: 1200 },
      ],
    });
  });

  test('allows a file at exactly the maximum', () => {
    const files: FileLength[] = [{ path: 'src/exact.ts', lines: 1000 }];

    expect(evaluateFileLengths(files, {})).toMatchObject({
      violations: [],
      currentOversized: [],
    });
  });

  test('allows an oversized file at its exact baseline', () => {
    const files: FileLength[] = [{ path: 'src/legacy.ts', lines: 1200 }];

    expect(evaluateFileLengths(files, { 'src/legacy.ts': 1200 })).toMatchObject({
      violations: [],
      currentOversized: [{ path: 'src/legacy.ts', lines: 1200 }],
    });
  });

  test('reports a shrinking oversized baseline file as stale', () => {
    const files: FileLength[] = [{ path: 'src/legacy.ts', lines: 1100 }];

    expect(evaluateFileLengths(files, { 'src/legacy.ts': 1200 })).toMatchObject({
      violations: [
        {
          kind: 'baseline-stale',
          path: 'src/legacy.ts',
          currentLines: 1100,
          baselineLines: 1200,
        },
      ],
    });
  });

  test('reports a baseline file that reaches the maximum as stale', () => {
    const files: FileLength[] = [{ path: 'src/legacy.ts', lines: 1000 }];

    expect(evaluateFileLengths(files, { 'src/legacy.ts': 1200 })).toMatchObject({
      violations: [
        {
          kind: 'baseline-stale',
          path: 'src/legacy.ts',
          currentLines: 1000,
          baselineLines: 1200,
        },
      ],
    });
  });

  test('reports a missing baseline path', () => {
    expect(evaluateFileLengths([], { 'src/deleted.ts': 1200 })).toMatchObject({
      violations: [{ kind: 'baseline-missing', path: 'src/deleted.ts', baselineLines: 1200 }],
    });
  });

  test('sorts violations by path', () => {
    const files: FileLength[] = [
      { path: 'src/z-new.ts', lines: 1001 },
      { path: 'src/a-legacy.ts', lines: 1201 },
    ];

    expect(
      evaluateFileLengths(files, {
        'src/a-legacy.ts': 1200,
        'src/missing.ts': 1200,
      }).violations.map((violation) => violation.path)
    ).toEqual(['src/a-legacy.ts', 'src/missing.ts', 'src/z-new.ts']);

    expect(evaluateFileLengths(files, { 'src/a-legacy.ts': 1200 }).currentOversized).toEqual([
      { path: 'src/a-legacy.ts', lines: 1201 },
      { path: 'src/z-new.ts', lines: 1001 },
    ]);
  });
});

describe('planBaselineUpdate', () => {
  test('lowers a shrinking oversized baseline entry', () => {
    const evaluation = evaluateFileLengths([{ path: 'src/legacy.ts', lines: 1100 }], {
      'src/legacy.ts': 1200,
    });

    expect(planBaselineUpdate(evaluation)).toEqual({
      ok: true,
      baseline: { 'src/legacy.ts': 1100 },
    });
  });

  test('removes entries at the maximum and entries for missing files', () => {
    const evaluation = evaluateFileLengths([{ path: 'src/exact.ts', lines: 1000 }], {
      'src/exact.ts': 1200,
      'src/missing.ts': 1200,
    });

    expect(planBaselineUpdate(evaluation)).toEqual({ ok: true, baseline: {} });
  });

  test('creates a path-sorted baseline', () => {
    const evaluation = evaluateFileLengths(
      [
        { path: 'src/z.ts', lines: 1200 },
        { path: 'src/a.ts', lines: 1100 },
      ],
      { 'src/z.ts': 1200, 'src/a.ts': 1300 }
    );

    const plan = planBaselineUpdate(evaluation);

    expect(plan).toEqual({
      ok: true,
      baseline: { 'src/a.ts': 1100, 'src/z.ts': 1200 },
    });
    if (plan.ok) {
      expect(Object.keys(plan.baseline)).toEqual(['src/a.ts', 'src/z.ts']);
    }
  });

  test('refuses a file that grew beyond its baseline', () => {
    const evaluation = evaluateFileLengths([{ path: 'src/legacy.ts', lines: 1201 }], {
      'src/legacy.ts': 1200,
    });

    expect(planBaselineUpdate(evaluation)).toEqual({
      ok: false,
      blockingViolations: [
        { kind: 'grew', path: 'src/legacy.ts', currentLines: 1201, baselineLines: 1200 },
      ],
    });
  });

  test('refuses a newly oversized file', () => {
    const evaluation = evaluateFileLengths([{ path: 'src/new.ts', lines: 1001 }], {});

    expect(planBaselineUpdate(evaluation)).toEqual({
      ok: false,
      blockingViolations: [
        { kind: 'new-oversized', path: 'src/new.ts', currentLines: 1001, maxLines: 1000 },
      ],
    });
  });
});

describe('repository discovery and CLI', () => {
  test('discovers cached and unignored-untracked candidates, then reads their line counts', () => {
    const repositoryRoot = createTemporaryRepository();
    writeFileSync(join(repositoryRoot, '.gitignore'), 'src/ignored.ts\n');
    writeFileSync(join(repositoryRoot, 'src/cached.ts'), 'cached\n');
    writeFileSync(join(repositoryRoot, 'docs/excluded.ts'), 'excluded\n');
    writeFileSync(join(repositoryRoot, 'src/ignored.ts'), 'ignored\n');
    writeFileSync(join(repositoryRoot, 'src/untracked.ts'), 'one\ntwo\n');
    execFileSync('git', ['add', '.gitignore', 'src/cached.ts', 'docs/excluded.ts'], {
      cwd: repositoryRoot,
    });

    const paths = discoverCandidatePaths(repositoryRoot);

    expect(paths).toEqual(['src/cached.ts', 'src/untracked.ts']);
    expect(readFileLengths(repositoryRoot, paths)).toEqual([
      { path: 'src/cached.ts', lines: 1 },
      { path: 'src/untracked.ts', lines: 2 },
    ]);
  });

  test('refuses a Git-listed symlink that resolves outside the repository', () => {
    const repositoryRoot = createTemporaryRepository();
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'file-length-outside-'));
    temporaryDirectories.push(outsideDirectory);
    const outsideFile = join(outsideDirectory, 'outside.ts');
    writeFileSync(outsideFile, 'outside\n');
    symlinkSync(outsideFile, join(repositoryRoot, 'src/escape.ts'));
    execFileSync('git', ['add', 'src/escape.ts'], { cwd: repositoryRoot });

    expect(() => readFileLengths(repositoryRoot, discoverCandidatePaths(repositoryRoot))).toThrow(
      'escapes repository root'
    );
  });

  test('reports normal-mode violations through injected diagnostics', () => {
    const repositoryRoot = createTemporaryRepository();
    writeLines(join(repositoryRoot, 'src/legacy.ts'), 1201);
    execFileSync('git', ['add', 'src/legacy.ts'], { cwd: repositoryRoot });
    const baselinePath = join(repositoryRoot, 'baseline.json');
    writeFileSync(baselinePath, '{\n  "src/legacy.ts": 1200\n}\n');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = runFileLengthCli({
      repositoryRoot,
      baselinePath,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('src/legacy.ts');
    expect(stderr.join('')).toContain('1201');
    expect(stderr.join('')).toContain('1200');
    expect(stderr.join('')).toContain('reduce');
  });

  test('reports and removes a baseline entry for a tracked file deleted from the working tree', () => {
    const repositoryRoot = createTemporaryRepository();
    const deletedPath = join(repositoryRoot, 'src/deleted.ts');
    writeLines(deletedPath, 1200);
    execFileSync('git', ['add', 'src/deleted.ts'], { cwd: repositoryRoot });
    rmSync(deletedPath);
    const baselinePath = join(repositoryRoot, 'baseline.json');
    writeFileSync(baselinePath, '{\n  "src/deleted.ts": 1200\n}\n');
    const stderr: string[] = [];

    const normalExitCode = runFileLengthCli({
      repositoryRoot,
      baselinePath,
      stderr: (message) => stderr.push(message),
    });
    const updateExitCode = runFileLengthCli({
      repositoryRoot,
      baselinePath,
      args: ['--update'],
      stdout: () => undefined,
    });

    expect(normalExitCode).toBe(1);
    expect(stderr.join('')).toContain('src/deleted.ts: no longer exists');
    expect(updateExitCode).toBe(0);
    expect(readFileSync(baselinePath, 'utf8')).toBe('{}\n');
  });

  test('does not write an update when a growth violation blocks it', () => {
    const repositoryRoot = createTemporaryRepository();
    writeLines(join(repositoryRoot, 'src/legacy.ts'), 1201);
    execFileSync('git', ['add', 'src/legacy.ts'], { cwd: repositoryRoot });
    const baselinePath = join(repositoryRoot, 'baseline.json');
    const originalBaseline = '{\n  "src/legacy.ts": 1200\n}\n';
    writeFileSync(baselinePath, originalBaseline);
    const stderr: string[] = [];

    const exitCode = runFileLengthCli({
      repositoryRoot,
      baselinePath,
      args: ['--update'],
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(1);
    expect(readFileSync(baselinePath, 'utf8')).toBe(originalBaseline);
    expect(stderr.join('')).toContain('src/legacy.ts');
  });

  test('does not write an update when a new oversized file blocks otherwise downward changes', () => {
    const repositoryRoot = createTemporaryRepository();
    writeLines(join(repositoryRoot, 'src/legacy.ts'), 1100);
    writeLines(join(repositoryRoot, 'src/new.ts'), 1001);
    execFileSync('git', ['add', 'src/legacy.ts', 'src/new.ts'], { cwd: repositoryRoot });
    const baselinePath = join(repositoryRoot, 'baseline.json');
    const originalBaseline = '{\n  "src/legacy.ts": 1200\n}\n';
    writeFileSync(baselinePath, originalBaseline);

    const exitCode = runFileLengthCli({
      repositoryRoot,
      baselinePath,
      args: ['--update'],
      stderr: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(readFileSync(baselinePath, 'utf8')).toBe(originalBaseline);
  });

  test('writes a path-sorted, indented baseline with a final newline for downward updates', () => {
    const repositoryRoot = createTemporaryRepository();
    writeLines(join(repositoryRoot, 'src/a.ts'), 1100);
    writeLines(join(repositoryRoot, 'src/z.ts'), 1200);
    execFileSync('git', ['add', 'src/a.ts', 'src/z.ts'], { cwd: repositoryRoot });
    const baselinePath = join(repositoryRoot, 'baseline.json');
    writeFileSync(baselinePath, '{"src/z.ts":1200,"src/a.ts":1300}');

    const exitCode = runFileLengthCli({
      repositoryRoot,
      baselinePath,
      args: ['--update'],
      stdout: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(baselinePath, 'utf8')).toBe(
      '{\n  "src/a.ts": 1100,\n  "src/z.ts": 1200\n}\n'
    );
  });

  test('formats every violation with its path, count, and corrective action', () => {
    const diagnostics = formatFileLengthViolations([
      { kind: 'new-oversized', path: 'src/new.ts', currentLines: 1001, maxLines: 1000 },
      { kind: 'grew', path: 'src/grew.ts', currentLines: 1201, baselineLines: 1200 },
      { kind: 'baseline-stale', path: 'src/stale.ts', currentLines: 1100, baselineLines: 1200 },
      { kind: 'baseline-missing', path: 'src/missing.ts', baselineLines: 1200 },
    ]);

    expect(diagnostics).toContain('src/new.ts: 1001 lines exceeds the allowed 1000; reduce');
    expect(diagnostics).toContain('src/grew.ts: 1201 lines exceeds the recorded 1200; reduce');
    expect(diagnostics).toContain('src/stale.ts: 1100 lines is below the recorded 1200; run');
    expect(diagnostics).toContain(
      'src/missing.ts: no longer exists but has a recorded 1200-line baseline; run'
    );
  });

  test.each([
    ['malformed JSON', '{ not json'],
    ['zero', '{"src/legacy.ts":0}'],
    ['maximum', '{"src/legacy.ts":1000}'],
    ['fractional count', '{"src/legacy.ts":1000.5}'],
    ['unsafe path', '{"../legacy.ts":1200}'],
  ])('rejects a baseline with %s', (_description, baselineContents) => {
    const repositoryRoot = createTemporaryRepository();
    const baselinePath = join(repositoryRoot, 'baseline.json');
    writeFileSync(baselinePath, baselineContents);
    const stderr: string[] = [];

    const exitCode = runFileLengthCli({
      repositoryRoot,
      baselinePath,
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('Invalid file length baseline');
  });

  test('prints usage for unknown arguments', () => {
    const stderr: string[] = [];

    const exitCode = runFileLengthCli({
      args: ['--unexpected'],
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('Usage:');
  });
});
