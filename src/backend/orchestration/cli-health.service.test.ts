import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());
const mockResolve = vi.hoisted(() => vi.fn());
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

vi.mock('node:module', () => ({ createRequire: () => ({ resolve: mockResolve }) }));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock('@/backend/services/github', () => ({
  githubCLIService: {
    checkHealth: (...args: unknown[]) => mockGithubCheckHealth(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => mockLogger,
  getCurrentProcessEnv: () => ({ FACTORY_RUNTIME: 'preserved' }),
}));

import { execFile } from 'node:child_process';
import { cliHealthService } from './cli-health.service';

vi.mocked(execFile).mockImplementation(mockExecFile as never);

describe('cliHealthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliHealthService.clearCache();
    vi.stubGlobal('fetch', vi.fn());
    mockResolve.mockReturnValue(
      '/app/resources/app.asar/node_modules/@agentclientprotocol/codex-acp/dist/index.js'
    );
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

  it('checks bundled Codex health without a global CLI or npm freshness check', async () => {
    // Catches probing a global Codex that does not match the runtime used by sessions.
    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === process.execPath && args[1] === 'cli' && args[2] === '-V') {
        return Promise.resolve({ stdout: 'codex-cli 0.155.0\n', stderr: '' });
      }
      if (cmd === process.execPath && args[1] === 'cli' && args[2] === 'login') {
        return Promise.resolve({ stdout: 'authenticated', stderr: '' });
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const status = await cliHealthService.checkCodexCLI();

    expect(status).toEqual({
      isInstalled: true,
      isAuthenticated: true,
      version: 'codex-cli 0.155.0',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledWith(
      process.execPath,
      [
        '/app/resources/app.asar.unpacked/node_modules/@agentclientprotocol/codex-acp/dist/index.js',
        'cli',
        'login',
        'status',
      ],
      expect.objectContaining({ env: { FACTORY_RUNTIME: 'preserved', ELECTRON_RUN_AS_NODE: '1' } })
    );
  });

  it('returns bundled-runtime login instructions when authentication fails', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args[2] === '-V') {
        return Promise.resolve({ stdout: 'codex-cli 0.155.0\n', stderr: '' });
      }
      return Promise.reject(new Error('login required'));
    });
    expect(await cliHealthService.checkCodexCLI()).toMatchObject({
      isInstalled: true,
      isAuthenticated: false,
      error: expect.stringContaining('ff codex login'),
    });
  });

  it('reports a missing bundled runtime without suggesting a global install', async () => {
    mockResolve.mockImplementation(() => {
      throw new Error('package not found');
    });
    expect(await cliHealthService.checkCodexCLI()).toMatchObject({
      isInstalled: false,
      isAuthenticated: false,
      error: expect.stringContaining('Update or reinstall Factory Factory'),
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects global Codex upgrades because Factory Factory manages the runtime', async () => {
    await expect(cliHealthService.upgradeProviderCLI('CODEX')).rejects.toThrow(
      'Update Factory Factory'
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('upgrades provider CLI and returns refreshed health', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'installed\n', stderr: '' });
    const refreshed = {
      claude: { isInstalled: true, isAuthenticated: true, version: '1.0.0' },
      codex: { isInstalled: true, isAuthenticated: true, version: '0.5.0' },
      github: { isInstalled: true, isAuthenticated: true, version: '2.0.0' },
      allHealthy: true,
    };
    const checkHealthSpy = vi.spyOn(cliHealthService, 'checkHealth').mockResolvedValue(refreshed);

    const result = await cliHealthService.upgradeProviderCLI('CLAUDE');

    expect(result.provider).toBe('CLAUDE');
    expect(result.packageName).toBe('@anthropic-ai/claude-code');
    expect(result.command).toBe('claude update');
    expect(result.output).toContain('installed');
    expect(result.health).toBe(refreshed);
    expect(checkHealthSpy).toHaveBeenCalledWith(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      ['update'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('updates the Claude executable used by health checks and clears the outdated status', async () => {
    let installedVersion = '2.1.310';
    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'claude' && args[0] === 'update') {
        installedVersion = '2.1.312';
        return Promise.resolve({ stdout: 'Successfully updated', stderr: '' });
      }
      if (cmd === 'claude' && args[0] === '--version') {
        return Promise.resolve({ stdout: `${installedVersion} (Claude Code)`, stderr: '' });
      }
      if (cmd === 'claude' && args[0] === 'auth') {
        return Promise.resolve({ stdout: '{"loggedIn":true}', stderr: '' });
      }
      // A global package install can succeed without updating the active executable.
      if (cmd === 'npm') {
        return Promise.resolve({ stdout: 'installed', stderr: '' });
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: '2.1.312' }),
    } as never);
    vi.spyOn(cliHealthService, 'checkCodexCLI').mockResolvedValue({ isInstalled: true });
    mockGithubCheckHealth.mockResolvedValue({ isInstalled: true, isAuthenticated: true });
    expect((await cliHealthService.checkHealth()).claude.isOutdated).toBe(true);

    const result = await cliHealthService.upgradeProviderCLI('CLAUDE');

    expect(result.health.claude).toMatchObject({
      version: '2.1.312 (Claude Code)',
      latestVersion: '2.1.312',
      isOutdated: false,
    });
    expect((await cliHealthService.checkHealth()).claude.isOutdated).toBe(false);
  });

  it('reports an unsuccessful update when the active Claude remains outdated', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'Run brew upgrade claude-code', stderr: '' });
    vi.spyOn(cliHealthService, 'checkHealth').mockResolvedValue({
      claude: {
        isInstalled: true,
        version: '2.1.310',
        latestVersion: '2.1.312',
        isOutdated: true,
      },
      codex: { isInstalled: true },
      github: { isInstalled: true, isAuthenticated: true },
      allHealthy: true,
    });

    await expect(cliHealthService.upgradeProviderCLI('CLAUDE')).rejects.toThrow(
      /still outdated.*2\.1\.310.*2\.1\.312/
    );
    await expect(cliHealthService.upgradeProviderCLI('CLAUDE')).rejects.toThrow(
      'Run brew upgrade claude-code'
    );
  });

  it('includes process stdout/stderr when CLI upgrade fails', async () => {
    mockExecFile.mockRejectedValue({
      message: 'npm failed',
      stderr: 'EACCES',
      stdout: 'partial output',
    });

    await expect(cliHealthService.upgradeProviderCLI('CLAUDE')).rejects.toThrow(
      'Failed to upgrade Claude CLI via claude update'
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
    expect(mockGithubCheckHealth).toHaveBeenCalledTimes(1);
    expect(mockGithubCheckHealth).toHaveBeenCalledWith(true);
    expect(first.allHealthy).toBe(true);
  });

  it('prevents an older aggregate refresh from overwriting a forced result', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const healthy = { isInstalled: true, isAuthenticated: true };
    const checkClaude = vi.spyOn(cliHealthService, 'checkClaudeCLI').mockResolvedValue(healthy);
    vi.spyOn(cliHealthService, 'checkCodexCLI').mockResolvedValue(healthy);
    mockGithubCheckHealth.mockResolvedValue(healthy);
    await cliHealthService.checkHealth();

    let finishOld!: (value: typeof healthy) => void;
    checkClaude.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      })
    );
    now.mockReturnValue(30_001);
    await cliHealthService.checkHealth();
    const forced = cliHealthService.checkHealth(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishOld({ isInstalled: true, isAuthenticated: false });
    expect((await forced).allHealthy).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await cliHealthService.checkHealth()).allHealthy).toBe(true);
  });

  it('keeps post-upgrade health when a cleared background refresh finishes later', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const healthy = { isInstalled: true, isAuthenticated: true };
    const checkClaude = vi.spyOn(cliHealthService, 'checkClaudeCLI').mockResolvedValue(healthy);
    vi.spyOn(cliHealthService, 'checkCodexCLI').mockResolvedValue(healthy);
    mockGithubCheckHealth.mockResolvedValue(healthy);
    await cliHealthService.checkHealth();

    let finishOld!: (value: typeof healthy) => void;
    checkClaude.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      })
    );
    now.mockReturnValue(30_001);
    await cliHealthService.checkHealth();
    mockExecFile.mockResolvedValue({ stdout: 'upgraded', stderr: '' });
    expect((await cliHealthService.upgradeProviderCLI('CLAUDE')).health.allHealthy).toBe(true);

    finishOld({ isInstalled: false, isAuthenticated: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await cliHealthService.checkHealth()).allHealthy).toBe(true);
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
