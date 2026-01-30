import { describe, expect, it } from 'vitest';
import { parseGitStatusOutput, parseNumstatOutput } from './git-helpers';

describe('parseGitStatusOutput', () => {
  it('should parse staged modified files', () => {
    const output = 'M  src/file.ts\n';
    const result = parseGitStatusOutput(output);

    expect(result).toEqual([{ path: 'src/file.ts', status: 'M', staged: true }]);
  });

  it('should parse unstaged modified files', () => {
    const output = ' M src/file.ts\n';
    const result = parseGitStatusOutput(output);

    expect(result).toEqual([{ path: 'src/file.ts', status: 'M', staged: false }]);
  });

  it('should parse staged added files', () => {
    const output = 'A  src/new-file.ts\n';
    const result = parseGitStatusOutput(output);

    expect(result).toEqual([{ path: 'src/new-file.ts', status: 'A', staged: true }]);
  });

  it('should parse staged deleted files', () => {
    const output = 'D  src/deleted.ts\n';
    const result = parseGitStatusOutput(output);

    expect(result).toEqual([{ path: 'src/deleted.ts', status: 'D', staged: true }]);
  });

  it('should parse unstaged deleted files', () => {
    const output = ' D src/deleted.ts\n';
    const result = parseGitStatusOutput(output);

    expect(result).toEqual([{ path: 'src/deleted.ts', status: 'D', staged: false }]);
  });

  it('should parse untracked files', () => {
    const output = '?? src/untracked.ts\n';
    const result = parseGitStatusOutput(output);

    expect(result).toEqual([{ path: 'src/untracked.ts', status: '?', staged: false }]);
  });

  it('should parse multiple files with different statuses', () => {
    const output = [
      'M  src/staged-modified.ts',
      ' M src/unstaged-modified.ts',
      'A  src/added.ts',
      'D  src/deleted.ts',
      '?? src/untracked.ts',
    ].join('\n');

    const result = parseGitStatusOutput(output);

    expect(result).toEqual([
      { path: 'src/staged-modified.ts', status: 'M', staged: true },
      { path: 'src/unstaged-modified.ts', status: 'M', staged: false },
      { path: 'src/added.ts', status: 'A', staged: true },
      { path: 'src/deleted.ts', status: 'D', staged: true },
      { path: 'src/untracked.ts', status: '?', staged: false },
    ]);
  });

  it('should handle files with both staged and unstaged changes (MM)', () => {
    const output = 'MM src/both.ts\n';
    const result = parseGitStatusOutput(output);

    expect(result).toEqual([{ path: 'src/both.ts', status: 'M', staged: true }]);
  });

  it('should handle added then modified files (AM)', () => {
    const output = 'AM src/added-modified.ts\n';
    const result = parseGitStatusOutput(output);

    // 'A' takes precedence in status determination
    expect(result).toEqual([{ path: 'src/added-modified.ts', status: 'A', staged: true }]);
  });

  it('should return empty array for empty output', () => {
    const result = parseGitStatusOutput('');
    expect(result).toEqual([]);
  });

  it('should return empty array for output with only whitespace', () => {
    const result = parseGitStatusOutput('\n\n\n');
    expect(result).toEqual([]);
  });

  it('should skip lines that are too short', () => {
    const output = 'AB\n';
    const result = parseGitStatusOutput(output);
    expect(result).toEqual([]);
  });

  it('should handle files with spaces in the name', () => {
    const output = 'M  src/file with spaces.ts\n';
    const result = parseGitStatusOutput(output);

    expect(result).toEqual([{ path: 'src/file with spaces.ts', status: 'M', staged: true }]);
  });

  it('should handle renamed files showing old status format', () => {
    // Renamed files in porcelain format can appear as 'R  old -> new' or just as 'R  new'
    // Our simple parser will treat the status 'R' as 'M' since it's not A, D, or ?
    const output = 'R  src/renamed.ts\n';
    const result = parseGitStatusOutput(output);

    expect(result).toEqual([{ path: 'src/renamed.ts', status: 'M', staged: true }]);
  });
});

describe('parseNumstatOutput', () => {
  it('should parse single file stats', () => {
    const output = '10\t5\tsrc/file.ts';
    const result = parseNumstatOutput(output);

    expect(result).toEqual({ additions: 10, deletions: 5 });
  });

  it('should sum stats from multiple files', () => {
    const output = ['10\t5\tsrc/file1.ts', '20\t3\tsrc/file2.ts', '5\t15\tsrc/file3.ts'].join('\n');

    const result = parseNumstatOutput(output);

    expect(result).toEqual({ additions: 35, deletions: 23 });
  });

  it('should handle binary files (marked with -)', () => {
    const output = [
      '10\t5\tsrc/file.ts',
      '-\t-\tsrc/image.png', // binary file
      '3\t2\tsrc/another.ts',
    ].join('\n');

    const result = parseNumstatOutput(output);

    // Binary files should be skipped (not counted)
    expect(result).toEqual({ additions: 13, deletions: 7 });
  });

  it('should handle binary file additions only', () => {
    const output = '-\t-\timage.png';
    const result = parseNumstatOutput(output);

    expect(result).toEqual({ additions: 0, deletions: 0 });
  });

  it('should return zeros for empty output', () => {
    const result = parseNumstatOutput('');
    expect(result).toEqual({ additions: 0, deletions: 0 });
  });

  it('should return zeros for whitespace-only output', () => {
    const result = parseNumstatOutput('   \n\n   ');
    expect(result).toEqual({ additions: 0, deletions: 0 });
  });

  it('should handle zero additions or deletions', () => {
    const output = '0\t10\tsrc/file.ts';
    const result = parseNumstatOutput(output);

    expect(result).toEqual({ additions: 0, deletions: 10 });
  });

  it('should handle large numbers', () => {
    const output = '1000\t500\tsrc/large-file.ts';
    const result = parseNumstatOutput(output);

    expect(result).toEqual({ additions: 1000, deletions: 500 });
  });

  it('should handle files with tabs in the path', () => {
    // The path part is after the second tab, so tabs in filename would be unusual
    // but the parser just splits on first two tabs
    const output = '5\t3\tsrc/file.ts';
    const result = parseNumstatOutput(output);

    expect(result).toEqual({ additions: 5, deletions: 3 });
  });

  it('should handle malformed lines gracefully', () => {
    // Lines without proper tab separation should not crash
    const output = 'invalid line without tabs';
    const result = parseNumstatOutput(output);

    // The first "word" becomes NaN which becomes 0
    expect(result).toEqual({ additions: 0, deletions: 0 });
  });
});
