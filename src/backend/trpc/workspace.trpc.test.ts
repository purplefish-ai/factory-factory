import { describe, expect, it } from 'vitest';
import { parseGitStatusOutput } from './workspace.trpc';

// =============================================================================
// parseGitStatusOutput Tests
// =============================================================================

describe('parseGitStatusOutput', () => {
  describe('basic parsing', () => {
    it('should parse unstaged modified file correctly', () => {
      // Leading space indicates not staged, M indicates modified
      const output = ' M README.md\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: 'README.md',
        status: 'M',
        staged: false,
      });
    });

    it('should parse staged modified file correctly', () => {
      // M in first position indicates staged
      const output = 'M  README.md\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: 'README.md',
        status: 'M',
        staged: true,
      });
    });

    it('should parse untracked file correctly', () => {
      const output = '?? newfile.txt\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: 'newfile.txt',
        status: '?',
        staged: false,
      });
    });

    it('should parse staged added file correctly', () => {
      const output = 'A  newfile.txt\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: 'newfile.txt',
        status: 'A',
        staged: true,
      });
    });

    it('should parse staged deleted file correctly', () => {
      const output = 'D  oldfile.txt\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: 'oldfile.txt',
        status: 'D',
        staged: true,
      });
    });

    it('should parse unstaged deleted file correctly', () => {
      const output = ' D oldfile.txt\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: 'oldfile.txt',
        status: 'D',
        staged: false,
      });
    });
  });

  describe('multiple files', () => {
    it('should parse multiple files correctly', () => {
      const output = ' M README.md\nM  package.json\n?? newfile.txt\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        path: 'README.md',
        status: 'M',
        staged: false,
      });
      expect(result[1]).toEqual({
        path: 'package.json',
        status: 'M',
        staged: true,
      });
      expect(result[2]).toEqual({
        path: 'newfile.txt',
        status: '?',
        staged: false,
      });
    });

    it('should handle mix of staged and unstaged changes to same file', () => {
      // MM means modified in both index and worktree
      const output = 'MM file.txt\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: 'file.txt',
        status: 'M',
        staged: true, // First column has M, so it's staged
      });
    });
  });

  describe('file paths', () => {
    it('should handle files in subdirectories', () => {
      const output = ' M src/components/Button.tsx\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('src/components/Button.tsx');
    });

    it('should handle deeply nested paths', () => {
      const output = ' M src/app/projects/[slug]/workspaces/[id]/page.tsx\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('src/app/projects/[slug]/workspaces/[id]/page.tsx');
    });

    it('should handle files with spaces in name', () => {
      // Git porcelain format quotes filenames with special characters
      const output = ' M "file with spaces.txt"\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('"file with spaces.txt"');
    });

    it('should handle dotfiles', () => {
      const output = ' M .gitignore\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('.gitignore');
    });
  });

  describe('edge cases', () => {
    it('should handle empty output', () => {
      const result = parseGitStatusOutput('');
      expect(result).toHaveLength(0);
    });

    it('should handle output with only newlines', () => {
      const result = parseGitStatusOutput('\n\n\n');
      expect(result).toHaveLength(0);
    });

    it('should handle output without trailing newline', () => {
      const output = ' M README.md';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('README.md');
    });

    it('should skip lines that are too short', () => {
      const output = 'M\n M README.md\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('README.md');
    });

    it('should preserve leading space in filename parsing (regression test for first-letter bug)', () => {
      // This is the specific bug that was fixed - the leading space in " M README.md"
      // was being trimmed, causing the file to show as "EADME.md"
      const output = ' M README.md\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('README.md');
      expect(result[0].path).not.toBe('EADME.md'); // The bug caused this
      expect(result[0].staged).toBe(false); // Leading space means not staged
    });

    it('should correctly identify staged vs unstaged when output starts with space', () => {
      // Regression test: ensure the leading space in position 0 is preserved
      const unstagedOutput = ' M file.txt\n';
      const stagedOutput = 'M  file.txt\n';

      const unstagedResult = parseGitStatusOutput(unstagedOutput);
      const stagedResult = parseGitStatusOutput(stagedOutput);

      expect(unstagedResult[0].staged).toBe(false);
      expect(stagedResult[0].staged).toBe(true);
    });
  });

  describe('status priority', () => {
    it('should prioritize untracked status', () => {
      const output = '?? file.txt\n';
      const result = parseGitStatusOutput(output);
      expect(result[0].status).toBe('?');
    });

    it('should prioritize added status over modified', () => {
      const output = 'A  file.txt\n';
      const result = parseGitStatusOutput(output);
      expect(result[0].status).toBe('A');
    });

    it('should prioritize deleted status', () => {
      const output = 'D  file.txt\n';
      const result = parseGitStatusOutput(output);
      expect(result[0].status).toBe('D');
    });

    it('should fall back to modified status', () => {
      const output = 'M  file.txt\n';
      const result = parseGitStatusOutput(output);
      expect(result[0].status).toBe('M');
    });
  });

  describe('renamed files', () => {
    it('should handle renamed files format', () => {
      // Renamed files show as "R  old.txt -> new.txt"
      const output = 'R  old.txt -> new.txt\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      // The current implementation treats R as modified (falls through to else)
      expect(result[0].path).toBe('old.txt -> new.txt');
      expect(result[0].staged).toBe(true);
    });
  });

  describe('copied files', () => {
    it('should handle copied files format', () => {
      const output = 'C  source.txt -> dest.txt\n';
      const result = parseGitStatusOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('source.txt -> dest.txt');
      expect(result[0].staged).toBe(true);
    });
  });
});
