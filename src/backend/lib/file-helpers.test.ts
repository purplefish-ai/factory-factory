import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguageFromPath, isBinaryContent, isPathSafe } from './file-helpers';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(),
}));

import { realpath } from 'node:fs/promises';

const mockedRealpath = vi.mocked(realpath);

describe('file-helpers', () => {
  describe('isPathSafe', () => {
    const worktreePath = '/home/user/project';

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    describe('safe paths', () => {
      it('should allow a simple file path', async () => {
        mockedRealpath.mockRejectedValue(new Error('ENOENT')); // File doesn't exist
        const result = await isPathSafe(worktreePath, 'src/index.ts');
        expect(result).toBe(true);
      });

      it('should allow nested directory paths', async () => {
        mockedRealpath.mockRejectedValue(new Error('ENOENT'));
        const result = await isPathSafe(worktreePath, 'src/components/Button/index.tsx');
        expect(result).toBe(true);
      });

      it('should allow paths with dots in filename', async () => {
        mockedRealpath.mockRejectedValue(new Error('ENOENT'));
        const result = await isPathSafe(worktreePath, 'file.config.js');
        expect(result).toBe(true);
      });

      it('should allow current directory reference when normalized', async () => {
        mockedRealpath.mockRejectedValue(new Error('ENOENT'));
        const result = await isPathSafe(worktreePath, './src/index.ts');
        expect(result).toBe(true);
      });

      it('should allow existing files within worktree', async () => {
        mockedRealpath.mockImplementation((p) => {
          if (p === path.resolve(worktreePath, 'src/index.ts')) {
            return Promise.resolve(path.resolve(worktreePath, 'src/index.ts'));
          }
          if (p === path.resolve(worktreePath)) {
            return Promise.resolve(path.resolve(worktreePath));
          }
          return Promise.reject(new Error('ENOENT'));
        });

        const result = await isPathSafe(worktreePath, 'src/index.ts');
        expect(result).toBe(true);
      });
    });

    describe('path traversal attempts', () => {
      it('should reject paths starting with ..', async () => {
        const result = await isPathSafe(worktreePath, '../etc/passwd');
        expect(result).toBe(false);
      });

      it('should reject paths with .. in the middle', async () => {
        const result = await isPathSafe(worktreePath, 'src/../../../etc/passwd');
        expect(result).toBe(false);
      });

      it('should reject absolute paths', async () => {
        const result = await isPathSafe(worktreePath, '/etc/passwd');
        expect(result).toBe(false);
      });

      it('should reject paths that normalize to traversal', async () => {
        const result = await isPathSafe(worktreePath, 'src/./../../outside');
        expect(result).toBe(false);
      });

      it('should reject paths that escape via trailing ..', async () => {
        // 'a/..' normalizes to '', then resolves to worktree itself which is allowed
        // But 'a/../..' escapes the worktree
        const result = await isPathSafe(worktreePath, 'a/../..');
        expect(result).toBe(false);
      });
    });

    describe('symlink scenarios', () => {
      it('should reject symlinks pointing outside worktree', async () => {
        mockedRealpath.mockImplementation((p) => {
          if (p === path.resolve(worktreePath, 'malicious-link')) {
            return Promise.resolve('/etc/passwd');
          }
          if (p === path.resolve(worktreePath)) {
            return Promise.resolve(path.resolve(worktreePath));
          }
          return Promise.reject(new Error('ENOENT'));
        });

        const result = await isPathSafe(worktreePath, 'malicious-link');
        expect(result).toBe(false);
      });

      it('should allow symlinks pointing within worktree', async () => {
        mockedRealpath.mockImplementation((p) => {
          if (p === path.resolve(worktreePath, 'link-to-src')) {
            return Promise.resolve(path.resolve(worktreePath, 'src'));
          }
          if (p === path.resolve(worktreePath)) {
            return Promise.resolve(path.resolve(worktreePath));
          }
          return Promise.reject(new Error('ENOENT'));
        });

        const result = await isPathSafe(worktreePath, 'link-to-src');
        expect(result).toBe(true);
      });

      it('should handle nested symlinks within worktree', async () => {
        mockedRealpath.mockImplementation((p) => {
          if (p === path.resolve(worktreePath, 'deep/nested/link')) {
            return Promise.resolve(path.resolve(worktreePath, 'actual/file.ts'));
          }
          if (p === path.resolve(worktreePath)) {
            return Promise.resolve(path.resolve(worktreePath));
          }
          return Promise.reject(new Error('ENOENT'));
        });

        const result = await isPathSafe(worktreePath, 'deep/nested/link');
        expect(result).toBe(true);
      });

      it('should handle worktree path that is itself a symlink', async () => {
        const symlinkWorktree = '/home/user/symlinked-project';
        const realWorktreePath = '/home/user/actual-project';

        mockedRealpath.mockImplementation((p) => {
          if (p === path.resolve(symlinkWorktree, 'src/index.ts')) {
            return Promise.resolve(path.resolve(realWorktreePath, 'src/index.ts'));
          }
          if (p === path.resolve(symlinkWorktree)) {
            return Promise.resolve(realWorktreePath);
          }
          return Promise.reject(new Error('ENOENT'));
        });

        const result = await isPathSafe(symlinkWorktree, 'src/index.ts');
        expect(result).toBe(true);
      });
    });
  });

  describe('getLanguageFromPath', () => {
    it('should return typescript for .ts files', () => {
      expect(getLanguageFromPath('src/index.ts')).toBe('typescript');
    });

    it('should return tsx for .tsx files', () => {
      expect(getLanguageFromPath('components/Button.tsx')).toBe('tsx');
    });

    it('should return javascript for .js files', () => {
      expect(getLanguageFromPath('lib/utils.js')).toBe('javascript');
    });

    it('should return jsx for .jsx files', () => {
      expect(getLanguageFromPath('components/App.jsx')).toBe('jsx');
    });

    it('should return python for .py files', () => {
      expect(getLanguageFromPath('scripts/main.py')).toBe('python');
    });

    it('should return ruby for .rb files', () => {
      expect(getLanguageFromPath('app/models/user.rb')).toBe('ruby');
    });

    it('should return go for .go files', () => {
      expect(getLanguageFromPath('cmd/main.go')).toBe('go');
    });

    it('should return rust for .rs files', () => {
      expect(getLanguageFromPath('src/main.rs')).toBe('rust');
    });

    it('should return java for .java files', () => {
      expect(getLanguageFromPath('src/Main.java')).toBe('java');
    });

    it('should return kotlin for .kt files', () => {
      expect(getLanguageFromPath('src/App.kt')).toBe('kotlin');
    });

    it('should return swift for .swift files', () => {
      expect(getLanguageFromPath('Sources/main.swift')).toBe('swift');
    });

    it('should return css for .css files', () => {
      expect(getLanguageFromPath('styles/main.css')).toBe('css');
    });

    it('should return scss for .scss files', () => {
      expect(getLanguageFromPath('styles/theme.scss')).toBe('scss');
    });

    it('should return html for .html files', () => {
      expect(getLanguageFromPath('public/index.html')).toBe('html');
    });

    it('should return xml for .xml files', () => {
      expect(getLanguageFromPath('config/settings.xml')).toBe('xml');
    });

    it('should return json for .json files', () => {
      expect(getLanguageFromPath('package.json')).toBe('json');
    });

    it('should return yaml for .yaml files', () => {
      expect(getLanguageFromPath('docker-compose.yaml')).toBe('yaml');
    });

    it('should return yaml for .yml files', () => {
      expect(getLanguageFromPath('.github/workflows/ci.yml')).toBe('yaml');
    });

    it('should return markdown for .md files', () => {
      expect(getLanguageFromPath('README.md')).toBe('markdown');
    });

    it('should return bash for .sh files', () => {
      expect(getLanguageFromPath('scripts/deploy.sh')).toBe('bash');
    });

    it('should return bash for .bash files', () => {
      expect(getLanguageFromPath('script.bash')).toBe('bash');
    });

    it('should return bash for .zsh files', () => {
      expect(getLanguageFromPath('script.zsh')).toBe('bash');
    });

    it('should return text for dotfiles without proper extension', () => {
      // Files like .bashrc and .zshrc have no extension - the "extension" would be "bashrc" and "zshrc"
      expect(getLanguageFromPath('.bashrc')).toBe('text');
      expect(getLanguageFromPath('.zshrc')).toBe('text');
    });

    it('should return sql for .sql files', () => {
      expect(getLanguageFromPath('migrations/001_init.sql')).toBe('sql');
    });

    it('should return graphql for .graphql files', () => {
      expect(getLanguageFromPath('schema.graphql')).toBe('graphql');
    });

    it('should return prisma for .prisma files', () => {
      expect(getLanguageFromPath('prisma/schema.prisma')).toBe('prisma');
    });

    it('should return text for unknown extensions', () => {
      expect(getLanguageFromPath('data.xyz')).toBe('text');
    });

    it('should return text for files without extension', () => {
      expect(getLanguageFromPath('Makefile')).toBe('text');
    });

    it('should handle case-insensitive extensions', () => {
      expect(getLanguageFromPath('file.TS')).toBe('typescript');
      expect(getLanguageFromPath('file.JSON')).toBe('json');
    });

    it('should handle files with multiple dots', () => {
      expect(getLanguageFromPath('config.prod.json')).toBe('json');
      expect(getLanguageFromPath('styles.module.css')).toBe('css');
    });
  });

  describe('isBinaryContent', () => {
    it('should return false for text content', () => {
      const textBuffer = Buffer.from('Hello, World!\nThis is some text.');
      expect(isBinaryContent(textBuffer)).toBe(false);
    });

    it('should return false for UTF-8 text with special characters', () => {
      const utf8Buffer = Buffer.from('Hello, World! Special chars: \u00e9\u00e8\u00ea');
      expect(isBinaryContent(utf8Buffer)).toBe(false);
    });

    it('should return false for empty buffer', () => {
      const emptyBuffer = Buffer.alloc(0);
      expect(isBinaryContent(emptyBuffer)).toBe(false);
    });

    it('should return true for buffer with null bytes', () => {
      const binaryBuffer = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6c, 0x6f]);
      expect(isBinaryContent(binaryBuffer)).toBe(true);
    });

    it('should return true for buffer starting with null byte', () => {
      const binaryBuffer = Buffer.from([0x00, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      expect(isBinaryContent(binaryBuffer)).toBe(true);
    });

    it('should return true for typical binary file signature (PNG)', () => {
      // PNG file signature
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      expect(isBinaryContent(pngSignature)).toBe(true);
    });

    it('should return true for typical binary file signature (PDF)', () => {
      // PDF header followed by binary content
      const pdfBuffer = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.from([0x00, 0x01, 0x02])]);
      expect(isBinaryContent(pdfBuffer)).toBe(true);
    });

    it('should only check first 8KB of large files', () => {
      // Create a 10KB buffer with text, then null byte after 8KB
      const largeBuffer = Buffer.alloc(10_240);
      largeBuffer.fill(0x41); // Fill with 'A'
      largeBuffer[8500] = 0x00; // Null byte after 8KB mark

      expect(isBinaryContent(largeBuffer)).toBe(false);
    });

    it('should detect null byte within first 8KB', () => {
      const largeBuffer = Buffer.alloc(10_240);
      largeBuffer.fill(0x41); // Fill with 'A'
      largeBuffer[8000] = 0x00; // Null byte within 8KB

      expect(isBinaryContent(largeBuffer)).toBe(true);
    });

    it('should return false for JSON content', () => {
      const jsonBuffer = Buffer.from('{"name": "test", "value": 123}');
      expect(isBinaryContent(jsonBuffer)).toBe(false);
    });

    it('should return false for code content', () => {
      const codeBuffer = Buffer.from(`
function hello() {
  console.log("Hello, World!");
}
      `);
      expect(isBinaryContent(codeBuffer)).toBe(false);
    });
  });
});
