import { describe, expect, test } from 'vitest';
import {
  countPhysicalLines,
  evaluateFileLengths,
  type FileLength,
  isFileLengthCandidate,
} from './check-file-length';

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
