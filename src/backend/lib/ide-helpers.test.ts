import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkIdeAvailable,
  IDE_CONFIGS,
  openBuiltInIde,
  openCustomIde,
  openPathInIde,
} from './ide-helpers';
import * as shell from './shell';

// Mock the shell module
vi.mock('./shell', () => ({
  execCommand: vi.fn(),
}));

const mockExecCommand = vi.mocked(shell.execCommand);

describe('ide-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset process.platform for macOS tests
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ===========================================================================
  // IDE_CONFIGS Tests
  // ===========================================================================

  describe('IDE_CONFIGS', () => {
    it('should have cursor configuration', () => {
      expect(IDE_CONFIGS.cursor).toBeDefined();
      expect(IDE_CONFIGS.cursor!.cliCommand).toBe('cursor');
      expect(IDE_CONFIGS.cursor!.macAppName).toBe('Cursor');
      expect(IDE_CONFIGS.cursor!.macBundleId).toBe('com.todesktop.230313mzl4w4u92');
    });

    it('should have vscode configuration', () => {
      expect(IDE_CONFIGS.vscode).toBeDefined();
      expect(IDE_CONFIGS.vscode!.cliCommand).toBe('code');
      expect(IDE_CONFIGS.vscode!.macAppName).toBe('Visual Studio Code');
      expect(IDE_CONFIGS.vscode!.macBundleId).toBe('com.microsoft.VSCode');
    });
  });

  // ===========================================================================
  // checkIdeAvailable Tests
  // ===========================================================================

  describe('checkIdeAvailable', () => {
    it('should return false for unknown IDE', async () => {
      const result = await checkIdeAvailable('unknown-ide');
      expect(result).toBe(false);
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it('should return true when CLI is in PATH', async () => {
      mockExecCommand.mockResolvedValueOnce({
        stdout: '/usr/local/bin/cursor',
        stderr: '',
        code: 0,
      });

      const result = await checkIdeAvailable('cursor');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledWith('which', ['cursor']);
    });

    it('should check macOS app when CLI is not in PATH', async () => {
      mockExecCommand
        .mockRejectedValueOnce(new Error('which failed'))
        .mockResolvedValueOnce({ stdout: '/Applications/Cursor.app', stderr: '', code: 0 });

      const result = await checkIdeAvailable('cursor');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledTimes(2);
      expect(mockExecCommand).toHaveBeenNthCalledWith(1, 'which', ['cursor']);
      expect(mockExecCommand).toHaveBeenNthCalledWith(2, 'mdfind', [
        'kMDItemCFBundleIdentifier == "com.todesktop.230313mzl4w4u92"',
      ]);
    });

    it('should return false when neither CLI nor macOS app is available', async () => {
      mockExecCommand
        .mockRejectedValueOnce(new Error('which failed'))
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      const result = await checkIdeAvailable('cursor');
      expect(result).toBe(false);
    });

    it('should return false when mdfind fails', async () => {
      mockExecCommand
        .mockRejectedValueOnce(new Error('which failed'))
        .mockRejectedValueOnce(new Error('mdfind failed'));

      const result = await checkIdeAvailable('cursor');
      expect(result).toBe(false);
    });

    it('should not check macOS app on non-darwin platforms', async () => {
      vi.stubGlobal('process', { ...process, platform: 'linux' });
      mockExecCommand.mockRejectedValueOnce(new Error('which failed'));

      const result = await checkIdeAvailable('cursor');
      expect(result).toBe(false);
      expect(mockExecCommand).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // openCustomIde Tests
  // ===========================================================================

  describe('openCustomIde', () => {
    it('should execute simple command with path', async () => {
      mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      const result = await openCustomIde('myide {workspace}', '/path/to/workspace');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledWith('myide', ['/path/to/workspace']);
    });

    it('should handle path with spaces by quoting', async () => {
      mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      const result = await openCustomIde('myide {workspace}', '/path/with spaces/workspace');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledWith('myide', ['/path/with spaces/workspace']);
    });

    it('should handle command with additional arguments', async () => {
      mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      const result = await openCustomIde('myide --new-window {workspace}', '/path/to/workspace');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledWith('myide', ['--new-window', '/path/to/workspace']);
    });

    it('should throw error for commands with shell metacharacters', async () => {
      await expect(openCustomIde('myide; rm -rf /', '/path')).rejects.toThrow(
        'Custom command contains invalid characters'
      );
      await expect(openCustomIde('myide && evil', '/path')).rejects.toThrow(
        'Custom command contains invalid characters'
      );
      await expect(openCustomIde('myide | grep', '/path')).rejects.toThrow(
        'Custom command contains invalid characters'
      );
      await expect(openCustomIde('myide `whoami`', '/path')).rejects.toThrow(
        'Custom command contains invalid characters'
      );
      await expect(openCustomIde('myide $(whoami)', '/path')).rejects.toThrow(
        'Custom command contains invalid characters'
      );
    });

    it('should return false when command is empty', async () => {
      const result = await openCustomIde('', '/path/to/workspace');
      expect(result).toBe(false);
    });

    it('should return false when execCommand fails', async () => {
      mockExecCommand.mockRejectedValueOnce(new Error('Command failed'));

      const result = await openCustomIde('myide {workspace}', '/path/to/workspace');
      expect(result).toBe(false);
    });

    it('should handle command without workspace placeholder', async () => {
      mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      const result = await openCustomIde('myide /fixed/path', '/path/to/workspace');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledWith('myide', ['/fixed/path']);
    });
  });

  // ===========================================================================
  // openBuiltInIde Tests
  // ===========================================================================

  describe('openBuiltInIde', () => {
    it('should return false for unknown IDE', async () => {
      const result = await openBuiltInIde('unknown-ide', '/path');
      expect(result).toBe(false);
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it('should open using CLI command', async () => {
      mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      const result = await openBuiltInIde('cursor', '/path/to/workspace');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledWith('cursor', ['/path/to/workspace']);
    });

    it('should fallback to open -a on macOS when CLI fails', async () => {
      mockExecCommand
        .mockRejectedValueOnce(new Error('cursor not found'))
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      const result = await openBuiltInIde('cursor', '/path/to/workspace');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledTimes(2);
      expect(mockExecCommand).toHaveBeenNthCalledWith(1, 'cursor', ['/path/to/workspace']);
      expect(mockExecCommand).toHaveBeenNthCalledWith(2, 'open', [
        '-a',
        'Cursor',
        '/path/to/workspace',
      ]);
    });

    it('should return false when both CLI and open -a fail on macOS', async () => {
      mockExecCommand
        .mockRejectedValueOnce(new Error('cursor not found'))
        .mockRejectedValueOnce(new Error('open failed'));

      const result = await openBuiltInIde('cursor', '/path/to/workspace');
      expect(result).toBe(false);
    });

    it('should not try open -a on non-darwin platforms', async () => {
      vi.stubGlobal('process', { ...process, platform: 'linux' });
      mockExecCommand.mockRejectedValueOnce(new Error('cursor not found'));

      const result = await openBuiltInIde('cursor', '/path/to/workspace');
      expect(result).toBe(false);
      expect(mockExecCommand).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // openPathInIde Tests
  // ===========================================================================

  describe('openPathInIde', () => {
    it('should delegate to openBuiltInIde for built-in IDEs', async () => {
      mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      const result = await openPathInIde('cursor', '/path/to/workspace');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledWith('cursor', ['/path/to/workspace']);
    });

    it('should delegate to openBuiltInIde for vscode', async () => {
      mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      const result = await openPathInIde('vscode', '/path/to/workspace');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledWith('code', ['/path/to/workspace']);
    });

    it('should delegate to openCustomIde for custom IDE', async () => {
      mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      const result = await openPathInIde('custom', '/path/to/workspace', 'myide {workspace}');
      expect(result).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledWith('myide', ['/path/to/workspace']);
    });

    it('should return false for custom IDE without command', async () => {
      const result = await openPathInIde('custom', '/path/to/workspace');
      expect(result).toBe(false);
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it('should return false for custom IDE with null command', async () => {
      const result = await openPathInIde('custom', '/path/to/workspace', null);
      expect(result).toBe(false);
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it('should return false for custom IDE with empty string command', async () => {
      const result = await openPathInIde('custom', '/path/to/workspace', '');
      expect(result).toBe(false);
    });

    it('should return false for unknown IDE', async () => {
      const result = await openPathInIde('unknown', '/path/to/workspace');
      expect(result).toBe(false);
    });
  });
});
