import './run-script-legacy.test-support';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunScriptExecution } from './run-script-execution';
import {
  FakeChildProcess,
  mockSpawn,
  mockTreeKill,
  mockFindById,
  mockStart,
  mockMarkFailed,
  mockVerifyRunning,
  mockFindFreePort,
  mockGetTunnelUrl,
  mockReconcileWorkspaceCommandCache,
} from './run-script-legacy.test-support';
import { RunScriptService } from './run-script.service';

describe('RunScriptService.startRunScript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStart.mockResolvedValue(true);
    mockFindFreePort.mockResolvedValue(5173);
    mockReconcileWorkspaceCommandCache.mockImplementation((input: { workspace: unknown }) => {
      const workspace = input.workspace as {
        runScriptCommand: string | null;
        runScriptPostRunCommand: string | null;
        runScriptCleanupCommand: string | null;
      };
      return {
        runScriptCommand: workspace.runScriptCommand,
        runScriptPostRunCommand: workspace.runScriptPostRunCommand,
        runScriptCleanupCommand: workspace.runScriptCleanupCommand,
      };
    });
    mockSpawn.mockImplementation(() => new FakeChildProcess(12_345));
  });

  it('returns error when workspace is missing', async () => {
    mockFindById.mockResolvedValue(null);

    const service = new RunScriptService();
    const result = await service.startRunScript('ws-missing');

    expect(result).toEqual({ success: false, error: 'Workspace not found' });
  });

  it('returns error when worktree path is missing', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: null,
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: null,
    });

    const service = new RunScriptService();
    const result = await service.startRunScript('ws-1');

    expect(result).toEqual({ success: false, error: 'Workspace worktree not initialized' });
  });

  it('returns error when workspace has no run script command', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: '/tmp/ws-1',
      runScriptCommand: null,
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: null,
    });

    const service = new RunScriptService();
    const result = await service.startRunScript('ws-1');

    expect(result).toEqual({
      success: false,
      error: 'No run script configured for this workspace',
    });
  });

  it('returns running metadata when state machine reports script already running', async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: 'ws-1',
        worktreePath: '/tmp/ws-1',
        runScriptCommand: 'pnpm dev',
        runScriptPostRunCommand: null,
        runScriptCleanupCommand: null,
      })
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptPid: 9876,
        runScriptPort: 4123,
      });
    mockStart.mockResolvedValue(false);

    const service = new RunScriptService();
    const result = await service.startRunScript('ws-1');

    expect(result).toEqual({
      success: false,
      error: 'Run script is already running',
      pid: 9876,
      port: 4123,
    });
  });

  it('allocates port, substitutes command, and transitions to running', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: '/tmp/ws-1',
      runScriptCommand: 'pnpm dev --port {port}',
      runScriptPostRunCommand: 'cloudflared --url http://localhost:{port}',
      runScriptCleanupCommand: null,
    });

    const service = new RunScriptService();
    const transitionSpy = vi
      .spyOn(RunScriptExecution.prototype, 'finishStartup')
      .mockResolvedValue({
        success: true,
        pid: 12_345,
        port: 5173,
      });

    const result = await service.startRunScript('ws-1');

    expect(mockFindFreePort).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith('bash', ['-c', 'pnpm dev --port 5173'], {
      cwd: '/tmp/ws-1',
      env: expect.any(Object),
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(transitionSpy).toHaveBeenCalledWith(
      12_345,
      5173,
      'cloudflared --url http://localhost:{port}',
      '/tmp/ws-1'
    );
    expect(result).toEqual({ success: true, pid: 12_345, port: 5173 });
    expect(service.getOutputBuffer('ws-1')).toContain('Starting pnpm dev --port 5173');
  });

  it('handles spawn without pid and marks STARTING state as failed', async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: 'ws-1',
        worktreePath: '/tmp/ws-1',
        runScriptCommand: 'pnpm dev',
        runScriptPostRunCommand: null,
        runScriptCleanupCommand: null,
      })
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptStatus: 'STARTING',
      });
    mockSpawn.mockImplementation(() => new FakeChildProcess(undefined));

    const service = new RunScriptService();
    const result = await service.startRunScript('ws-1');

    expect(result).toEqual({ success: false, error: 'Failed to spawn run script process' });
    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
  });

  it('does not mark failed for RunScriptStateMachineError start races', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: '/tmp/ws-1',
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: null,
    });
    const raceError = new Error('CAS failed');
    raceError.name = 'RunScriptStateMachineError';
    mockStart.mockRejectedValue(raceError);

    const service = new RunScriptService();
    const result = await service.startRunScript('ws-1');

    expect(result).toEqual({ success: false, error: 'CAS failed' });
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });
});

describe('RunScriptService.getRunScriptStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns status with postRun command', async () => {
    mockVerifyRunning.mockResolvedValue('RUNNING');
    mockFindById.mockResolvedValueOnce({ id: 'ws-1' }).mockResolvedValueOnce({
      id: 'ws-1',
      runScriptPid: 12_345,
      runScriptPort: 3000,
      runScriptStartedAt: new Date(),
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: 'cloudflared tunnel --url http://localhost:3000',
      runScriptCleanupCommand: null,
    });
    mockGetTunnelUrl.mockReturnValue('https://example.trycloudflare.com');

    const service = new RunScriptService();
    const result = await service.getRunScriptStatus('ws-1');

    expect(result.status).toBe('RUNNING');
    expect(result.runScriptPostRunCommand).toBe('cloudflared tunnel --url http://localhost:3000');
    expect(result.hasRunScript).toBe(true);
  });

  it('throws when workspace not found', async () => {
    mockFindById.mockResolvedValue(null);

    const service = new RunScriptService();
    await expect(service.getRunScriptStatus('ws-missing')).rejects.toThrow('Workspace not found');
  });

  it('throws when workspace disappears after verify', async () => {
    mockVerifyRunning.mockResolvedValue('IDLE');
    mockFindById.mockResolvedValueOnce({ id: 'ws-1' }).mockResolvedValueOnce(null);

    const service = new RunScriptService();
    await expect(service.getRunScriptStatus('ws-1')).rejects.toThrow('Workspace not found');
  });
});

describe('RunScriptService.start failure persistence', () => {
  it('marks failed from handleStartError when workspace is still STARTING', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'STARTING',
      worktreePath: '/tmp/ws-1',
      runScriptCommand: 'echo {port}',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: null,
    });
    mockFindFreePort.mockRejectedValue(new Error('bad start'));
    mockMarkFailed.mockResolvedValue(undefined);
    const service = new RunScriptService();

    const result = await service.startRunScript('ws-1');

    expect(result).toEqual({ success: false, error: 'bad start' });
    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
  });

  it('swallows markFailed errors inside handleStartError', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'STARTING',
      worktreePath: '/tmp/ws-1',
      runScriptCommand: 'echo {port}',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: null,
    });
    mockFindFreePort.mockRejectedValue(new Error('bad start'));
    mockMarkFailed.mockRejectedValue(new Error('db conflict'));
    const service = new RunScriptService();

    await expect(service.startRunScript('ws-1')).resolves.toEqual({
      success: false,
      error: 'bad start',
    });
  });
});

describe('RunScriptService cleanup command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => callback(null)
    );
  });

  it('runs cleanup script with substituted port and ignored output', async () => {
    const cleanupProcess = new FakeChildProcess(55_555);
    mockSpawn.mockReturnValue(cleanupProcess);
    const service = new RunScriptService() as unknown as {
      runCleanupScript: (
        workspaceId: string,
        workspace: {
          runScriptCleanupCommand: string;
          worktreePath: string;
          runScriptPort: number | null;
        }
      ) => Promise<void>;
    };

    const promise = service.runCleanupScript('ws-1', {
      runScriptCleanupCommand: 'echo cleanup {port}',
      worktreePath: '/tmp/ws-1',
      runScriptPort: 3000,
    });
    cleanupProcess.emit('exit', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith('bash', ['-c', 'echo cleanup 3000'], {
      cwd: '/tmp/ws-1',
      env: expect.any(Object),
      detached: false,
      stdio: 'ignore',
    });
  });

  it('resolves cleanup script when process emits error', async () => {
    const cleanupProcess = new FakeChildProcess(55_555);
    mockSpawn.mockReturnValue(cleanupProcess);
    const service = new RunScriptService() as unknown as {
      runCleanupScript: (
        workspaceId: string,
        workspace: {
          runScriptCleanupCommand: string;
          worktreePath: string;
          runScriptPort: number | null;
        }
      ) => Promise<void>;
    };

    const promise = service.runCleanupScript('ws-1', {
      runScriptCleanupCommand: 'echo cleanup',
      worktreePath: '/tmp/ws-1',
      runScriptPort: null,
    });
    cleanupProcess.emit('error', new Error('cleanup crashed'));
    await promise;
  });

  it('times out cleanup scripts and sends SIGTERM', async () => {
    vi.useFakeTimers();
    const cleanupProcess = new FakeChildProcess(55_555);
    mockSpawn.mockReturnValue(cleanupProcess);
    const service = new RunScriptService() as unknown as {
      runCleanupScript: (
        workspaceId: string,
        workspace: {
          runScriptCleanupCommand: string;
          worktreePath: string;
          runScriptPort: number | null;
        }
      ) => Promise<void>;
    };

    const promise = service.runCleanupScript('ws-1', {
      runScriptCleanupCommand: 'echo cleanup',
      worktreePath: '/tmp/ws-1',
      runScriptPort: null,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(cleanupProcess.kill).toHaveBeenCalledWith('SIGTERM');
    vi.useRealTimers();
  });

  it('swallows cleanup spawn exceptions', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn exploded');
    });
    const service = new RunScriptService() as unknown as {
      runCleanupScript: (
        workspaceId: string,
        workspace: {
          runScriptCleanupCommand: string;
          worktreePath: string;
          runScriptPort: number | null;
        }
      ) => Promise<void>;
    };

    await expect(
      service.runCleanupScript('ws-1', {
        runScriptCleanupCommand: 'echo cleanup',
        worktreePath: '/tmp/ws-1',
        runScriptPort: null,
      })
    ).resolves.toBeUndefined();
  });
});
