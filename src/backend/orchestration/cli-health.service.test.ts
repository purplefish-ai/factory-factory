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
    mockResolve.mockImplementation(
      (name: string) => `/app/resources/app.asar/node_modules/${name}`
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checks bundled Claude health without a global CLI or registry freshness', async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === process.execPath && args[1] === '--cli' && args[2] === '--version') {
        return Promise.resolve({ stdout: '2.1.310 (Claude Code)\n', stderr: '' });
      }
      if (cmd === process.execPath && args[1] === '--cli' && args[2] === 'auth') {
        return Promise.resolve({ stdout: '{"loggedIn":true}', stderr: '' });
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });
    expect(await cliHealthService.checkClaudeCLI()).toEqual({
      isInstalled: true,
      isAuthenticated: true,
      version: '2.1.310 (Claude Code)',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledWith(
      process.execPath,
      [
        '/app/resources/app.asar.unpacked/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
        '--cli',
        'auth',
        'status',
        '--json',
      ],
      expect.objectContaining({ env: { FACTORY_RUNTIME: 'preserved', ELECTRON_RUN_AS_NODE: '1' } })
    );
  });

  it.each(['{"loggedIn":false}', '{"loggedIn":"true"}', 'null', 'invalid json'])(
    'reports native login instructions for invalid or signed-out auth: %s',
    async (stdout) => {
      mockExecFile.mockImplementation((_cmd: string, args: string[]) =>
        Promise.resolve({
          stdout: args[2] === '--version' ? '2.1.310 (Claude Code)' : stdout,
          stderr: '',
        })
      );
      expect(await cliHealthService.checkClaudeCLI()).toMatchObject({
        isInstalled: true,
        isAuthenticated: false,
        error: expect.stringContaining('ff claude auth login'),
      });
    }
  );

  it('preserves runtime availability when the native auth command fails', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[]) =>
      args[2] === '--version'
        ? Promise.resolve({ stdout: '2.1.310 (Claude Code)', stderr: '' })
        : Promise.reject(new Error('auth unavailable'))
    );
    expect(await cliHealthService.checkClaudeCLI()).toMatchObject({
      isInstalled: true,
      isAuthenticated: false,
      error: expect.stringContaining('ff claude auth login'),
    });
  });

  it('reports app repair when the bundled Claude executable is missing', async () => {
    mockExecFile.mockRejectedValue(new Error('spawn native Claude ENOENT'));
    expect(await cliHealthService.checkClaudeCLI()).toMatchObject({
      isInstalled: false,
      isAuthenticated: false,
      error: expect.stringContaining('Update or reinstall Factory Factory'),
    });
  });

  it('reports app repair when the Claude ACP package is missing', async () => {
    mockResolve.mockImplementation(() => {
      throw new Error('package not found');
    });
    expect(await cliHealthService.checkClaudeCLI()).toMatchObject({
      isInstalled: false,
      error: expect.stringContaining('Update or reinstall Factory Factory'),
    });
    expect(mockExecFile).not.toHaveBeenCalled();
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

  it.each(['CLAUDE', 'CODEX'] as const)('rejects global %s upgrades', async (provider) => {
    await expect(cliHealthService.upgradeProviderCLI(provider)).rejects.toThrow(
      'Update Factory Factory'
    );
    expect(mockExecFile).not.toHaveBeenCalled();
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

  it('keeps refreshed health when a cleared background refresh finishes later', async () => {
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
    cliHealthService.clearCache();
    expect((await cliHealthService.checkHealth(true)).allHealthy).toBe(true);

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
