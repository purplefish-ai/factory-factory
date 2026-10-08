import { describe, expect, it } from 'vitest';
import { calculateLineNumberWidth, parseDetailedDiff, parseFileDiff } from './parse';

const diff = 'diff --git a/test.txt b/test.txt\n@@ -999 +999 @@\n-old\n+new\n';

describe('newline-terminated unified diffs', () => {
  it('does not fabricate a final context line or widen the line-number gutter', () => {
    const lines = parseDetailedDiff(diff);
    expect(lines).toEqual([
      { type: 'header', content: 'diff --git a/test.txt b/test.txt' },
      { type: 'hunk', content: '@@ -999 +999 @@' },
      { type: 'deletion', content: 'old', lineNumber: { old: 999 } },
      { type: 'addition', content: 'new', lineNumber: { new: 999 } },
    ]);
    expect(calculateLineNumberWidth(lines)).toBe(3);
  });

  it('ends the last file hunk at its final content line', () => {
    const files = parseFileDiff(diff);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { type: 'del', content: 'old' },
      { type: 'add', content: 'new' },
    ]);
  });

  it('preserves blank context at the end of a hunk', () => {
    const blankDiff = 'diff --git a/test.txt b/test.txt\n@@ -1,2 +1,2 @@\n line\n \n';
    expect(parseFileDiff(blankDiff)[0]?.hunks[0]?.lines).toEqual([
      { type: 'context', content: 'line' },
      { type: 'context', content: '' },
    ]);
    expect(parseDetailedDiff(blankDiff).at(-1)).toEqual({
      type: 'context',
      content: '',
      lineNumber: { old: 2, new: 2 },
    });
  });

  it('handles multiple files and no-newline markers without adding a blank row', () => {
    const multiDiff = `${diff}diff --git a/other.txt b/other.txt\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n`;
    expect(parseFileDiff(multiDiff).map((file) => file.hunks[0]?.lines.length)).toEqual([2, 2]);
    expect(parseDetailedDiff(multiDiff).filter((line) => line.type === 'context')).toEqual([]);
  });
});
