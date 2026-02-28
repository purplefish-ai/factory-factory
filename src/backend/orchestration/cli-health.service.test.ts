import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());
const mockGithubCheckHealth = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock('@/backend/domains/github', () => ({
  githubCLIService: {
    checkHealth: (...args: unknown[]) => mockGithubCheckHealth(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => mockLogger,
}));

import { execFile } from 'node:child_process';
import { cliHealthService } from './cli-health.service';

vi.mocked(execFile).mockImplementation(mockExecFile as never);

describe('cliHealthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliHealthService.clearCache();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checks Claude CLI install/auth state and version freshness', async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'claude' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'claude code 1.2.3\n', stderr: '' });
      }
      if (cmd === 'claude' && args[0] === 'auth') {
        return Promise.resolve({ stdout: '{"loggedIn":true}', stderr: '' });
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.3.0' }),
    } as never);

    const status = await cliHealthService.checkClaudeCLI();

    expect(status).toEqual(
      expect.objectContaining({
        isInstalled: true,
        isAuthenticated: true,
        version: '1.2.3',
        latestVersion: '1.3.0',
        isOutdated: true,
      })
    );
  });

  it('treats Claude auth check failures as unauthenticated and handles missing npm freshness', async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'claude' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'claude 1.2.3\n', stderr: '' });
      }
      if (cmd === 'claude' && args[0] === 'auth') {
        return Promise.reject(new Error('auth unavailable'));
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as never);

    const status = await cliHealthService.checkClaudeCLI();

    expect(status.isInstalled).toBe(true);
    expect(status.isAuthenticated).toBe(false);
    expect(status.latestVersion).toBeUndefined();
  });

  it('returns a not-installed error for missing Claude CLI', async () => {
    mockExecFile.mockRejectedValue(new Error('spawn claude ENOENT'));

    const status = await cliHealthService.checkClaudeCLI();

    expect(status).toEqual({
      isInstalled: false,
      isAuthenticated: false,
      error: 'Claude CLI is not installed. Install from https://claude.ai/download',
    });
  });

  it('checks Codex CLI install/auth state and freshness', async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'codex' && args[0] === '--version') {
        return Promise.resolve({ stdout: '0.5.0\n', stderr: '' });
      }
      if (cmd === 'codex' && args[0] === 'login') {
        return Promise.resolve({ stdout: 'authenticated', stderr: '' });
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.4.0' }),
    } as never);

    const status = await cliHealthService.checkCodexCLI();

    expect(status).toEqual(
      expect.objectContaining({
        isInstalled: true,
        isAuthenticated: true,
        version: '0.5.0',
        latestVersion: '0.4.0',
        isOutdated: false,
      })
    );
  });

  it('returns unauthenticated status when Codex login check fails', async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'codex' && args[0] === '--version') {
        return Promise.resolve({ stdout: '0.5.0\n', stderr: '' });
      }
      if (cmd === 'codex' && args[0] === 'login') {
        return Promise.reject(new Error('login required'));
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.6.0' }),
    } as never);

    const status = await cliHealthService.checkCodexCLI();

    expect(status).toEqual(
      expect.objectContaining({
        isInstalled: true,
        isAuthenticated: false,
        latestVersion: '0.6.0',
        isOutdated: true,
        error: 'Codex CLI is not authenticated. Run `codex login` to authenticate.',
      })
    );
  });

  it('returns a not-installed error for missing Codex CLI', async () => {
    mockExecFile.mockRejectedValue(new Error('spawn codex ENOENT'));

    const status = await cliHealthService.checkCodexCLI();

    expect(status).toEqual({
      isInstalled: false,
      isAuthenticated: false,
      error:
        'Codex CLI is not installed. Install from https://developers.openai.com/codex/app-server/',
    });
  });

  it('upgrades provider CLI and returns refreshed health', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'installed\n', stderr: '' });
    const refreshed = {
      claude: { isInstalled: true, isAuthenticated: true, version: '1.0.0' },
      codex: { isInstalled: true, isAuthenticated: true, version: '0.5.0' },
      opencode: { isInstalled: true, isAuthenticated: true, version: '1.0.0' },
      github: { isInstalled: true, isAuthenticated: true, version: '2.0.0' },
      allHealthy: true,
    };
    const checkHealthSpy = vi.spyOn(cliHealthService, 'checkHealth').mockResolvedValue(refreshed);

    const result = await cliHealthService.upgradeProviderCLI('CODEX');

    expect(result.provider).toBe('CODEX');
    expect(result.packageName).toBe('@openai/codex');
    expect(result.command).toBe('npm install -g @openai/codex');
    expect(result.output).toContain('installed');
    expect(result.health).toBe(refreshed);
    expect(checkHealthSpy).toHaveBeenCalledWith(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@openai/codex'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('includes process stdout/stderr when CLI upgrade fails', async () => {
    mockExecFile.mockRejectedValue({
      message: 'npm failed',
      stderr: 'EACCES',
      stdout: 'partial output',
    });

    await expect(cliHealthService.upgradeProviderCLI('CLAUDE')).rejects.toThrow(
      'Failed to upgrade Claude CLI via npm'
    );
  });

  it('uses cached health result unless force refresh is requested', async () => {
    const checkClaudeSpy = vi.spyOn(cliHealthService, 'checkClaudeCLI').mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
      version: 'claude 1.2.3',
    });
    const checkCodexSpy = vi.spyOn(cliHealthService, 'checkCodexCLI').mockResolvedValue({
      isInstalled: true,
      isAuthenticated: false,
      version: 'codex 0.5.0',
    });
    const checkOpencodeSpy = vi.spyOn(cliHealthService, 'checkOpencodeCLI').mockResolvedValue({
      isInstalled: true,
      isAuthenticated: false,
      version: 'opencode 1.0.0',
    });
    mockGithubCheckHealth.mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
      version: '2.0.0',
    });

    const first = await cliHealthService.checkHealth(true);
    const second = await cliHealthService.checkHealth(false);

    expect(first).toBe(second);
    expect(checkClaudeSpy).toHaveBeenCalledTimes(1);
    expect(checkCodexSpy).toHaveBeenCalledTimes(1);
    expect(checkOpencodeSpy).toHaveBeenCalledTimes(1);
    expect(mockGithubCheckHealth).toHaveBeenCalledTimes(1);
    expect(first.allHealthy).toBe(true);
  });

  it('reports unhealthy when Claude or GitHub are unauthenticated', async () => {
    vi.spyOn(cliHealthService, 'checkClaudeCLI').mockResolvedValue({
      isInstalled: true,
      isAuthenticated: false,
      version: 'claude 1.2.3',
    });
    vi.spyOn(cliHealthService, 'checkCodexCLI').mockResolvedValue({
      isInstalled: false,
      isAuthenticated: false,
    });
    vi.spyOn(cliHealthService, 'checkOpencodeCLI').mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
      version: '1.0.0',
    });
    mockGithubCheckHealth.mockResolvedValue({
      isInstalled: true,
      isAuthenticated: false,
      version: '2.0.0',
    });

    const status = await cliHealthService.checkHealth(true);

    expect(status.allHealthy).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
