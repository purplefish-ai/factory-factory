import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FactoryConfigService } from '@/backend/services/factory-config.service';

const mockSpawn = vi.fn();
const mockTreeKill = vi.fn();
const mockFindById = vi.fn();
const mockStart = vi.fn();
const mockBeginStopping = vi.fn();
const mockCompleteStopping = vi.fn();
const mockMarkCompleted = vi.fn();
const mockMarkFailed = vi.fn();
const mockMarkRunning = vi.fn();
const mockReset = vi.fn();
const mockVerifyRunning = vi.fn();
const mockFindFreePort = vi.fn();
const mockEnsureTunnel = vi.fn();
const mockStopTunnel = vi.fn();
const mockGetTunnelUrl = vi.fn();
const mockCleanupTunnels = vi.fn();
const mockCleanupTunnelsSync = vi.fn();
const mockReconcileWorkspaceCommandCache = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('tree-kill', () => ({
  default: (...args: unknown[]) => mockTreeKill(...args),
}));

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

vi.mock('./run-script-state-machine.service', () => ({
  runScriptStateMachine: {
    start: (...args: unknown[]) => mockStart(...args),
    beginStopping: (...args: unknown[]) => mockBeginStopping(...args),
    completeStopping: (...args: unknown[]) => mockCompleteStopping(...args),
    markCompleted: (...args: unknown[]) => mockMarkCompleted(...args),
    markFailed: (...args: unknown[]) => mockMarkFailed(...args),
    markRunning: (...args: unknown[]) => mockMarkRunning(...args),
    reset: (...args: unknown[]) => mockReset(...args),
    verifyRunning: (...args: unknown[]) => mockVerifyRunning(...args),
  },
}));

vi.mock('@/backend/services/port-allocation.service', () => ({
  PortAllocationService: {
    findFreePort: (...args: unknown[]) => mockFindFreePort(...args),
  },
}));

vi.mock('@/backend/services/run-script-proxy.service', () => ({
  runScriptProxyService: {
    ensureTunnel: (...args: unknown[]) => mockEnsureTunnel(...args),
    stopTunnel: (...args: unknown[]) => mockStopTunnel(...args),
    getTunnelUrl: (...args: unknown[]) => mockGetTunnelUrl(...args),
    cleanup: (...args: unknown[]) => mockCleanupTunnels(...args),
    cleanupSync: (...args: unknown[]) => mockCleanupTunnelsSync(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/backend/services/run-script-config-persistence.service', () => ({
  runScriptConfigPersistenceService: {
    reconcileWorkspaceCommandCache: (...args: unknown[]) =>
      mockReconcileWorkspaceCommandCache(...args),
  },
}));

import { RunScriptService } from './run-script.service';

class FakeChildProcess extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

type ExitHandlerCapable = {
  handleProcessExit: (
    workspaceId: string,
    childProcess: { pid: number },
    pid: number,
    code: number | null,
    signal: string | null
  ) => Promise<void>;
};

type StopHandlerCapable = {
  runningProcesses: Map<string, { pid: number }>;
  postRunProcesses: Map<string, { pid: number; killed: boolean; kill: (signal: string) => void }>;
};

type TransitionToRunningCapable = StopHandlerCapable & {
  transitionToRunning: (
    workspaceId: string,
    childProcess: { pid: number; exitCode: number | null },
    pid: number,
    port: number | undefined,
    runScriptPostRunCommand?: string | null,
    worktreePath?: string | null
  ) => Promise<{
    success: boolean;
    port?: number;
    pid?: number;
    proxyUrl?: string;
    error?: string;
  }>;
};

describe('RunScriptService.handleProcessExit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => callback(null)
    );
  });

  it('finalizes STOPPING state to IDLE when the process exits', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STOPPING' });
    mockCompleteStopping.mockResolvedValue(undefined);

    const service = new RunScriptService() as unknown as ExitHandlerCapable;

    await service.handleProcessExit('ws-1', { pid: 12_345 }, 12_345, 0, null);

    expect(mockFindById).toHaveBeenCalledWith('ws-1');
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('swallows completeStopping errors for STOPPING exits', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STOPPING' });
    mockCompleteStopping.mockRejectedValue(new Error('tree-kill failed'));

    const service = new RunScriptService() as unknown as ExitHandlerCapable;

    await expect(
      service.handleProcessExit('ws-1', { pid: 12_345 }, 12_345, 1, 'SIGTERM')
    ).resolves.toBe(undefined);
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('ignores stale process exits when a newer process is tracked', async () => {
    const service = new RunScriptService() as unknown as ExitHandlerCapable & {
      runningProcesses: Map<string, { pid: number }>;
      outputListeners: Map<string, Set<(data: string) => void>>;
    };
    const activeProcess = { pid: 22_222 };
    service.runningProcesses.set('ws-1', activeProcess);
    service.outputListeners.set('ws-1', new Set([(data: string) => data]));

    const staleProcess = { pid: 11_111 };
    await service.handleProcessExit('ws-1', staleProcess, 11_111, 0, null);

    expect(service.runningProcesses.get('ws-1')).toBe(activeProcess);
    expect(service.outputListeners.has('ws-1')).toBe(true);
    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });
});

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

    const service = new RunScriptService() as unknown as {
      startRunScript: (
        workspaceId: string
      ) => Promise<{ success: boolean; port?: number; pid?: number }>;
      getOutputBuffer: (workspaceId: string) => string;
      transitionToRunning: (
        workspaceId: string,
        childProcess: FakeChildProcess,
        pid: number,
        port: number | undefined,
        runScriptPostRunCommand?: string | null,
        worktreePath?: string | null
      ) => Promise<{ success: boolean; port?: number; pid?: number }>;
    };
    const transitionSpy = vi.spyOn(service, 'transitionToRunning').mockResolvedValue({
      success: true,
      pid: 12_345,
      port: 5173,
    });

    const result = await service.startRunScript('ws-1');

    expect(mockFindFreePort).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith('bash', ['-c', 'pnpm dev --port 5173'], {
      cwd: '/tmp/ws-1',
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(transitionSpy).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ pid: 12_345 }),
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

describe('RunScriptService.registerProcessHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures stdout/stderr output and handles spawn errors', async () => {
    mockMarkFailed.mockResolvedValue(undefined);
    const service = new RunScriptService() as unknown as {
      registerProcessHandlers: (
        workspaceId: string,
        childProcess: FakeChildProcess,
        pid: number
      ) => void;
      appendOutput: (workspaceId: string, output: string) => void;
      runningProcesses: Map<string, FakeChildProcess>;
    };
    const childProcess = new FakeChildProcess(12_345);
    service.runningProcesses.set('ws-1', childProcess);
    const appendSpy = vi.spyOn(service, 'appendOutput');

    service.registerProcessHandlers('ws-1', childProcess, 12_345);

    childProcess.stdout.emit('data', Buffer.from('stdout chunk'));
    childProcess.stderr.emit('data', Buffer.from('stderr chunk'));
    childProcess.stdout.emit('error', new Error('stdout stream failed'));
    childProcess.stderr.emit('error', new Error('stderr stream failed'));
    childProcess.emit('error', new Error('spawn failed'));
    await flushMicrotasks();

    expect(appendSpy).toHaveBeenNthCalledWith(1, 'ws-1', 'stdout chunk');
    expect(appendSpy).toHaveBeenNthCalledWith(2, 'ws-1', 'stderr chunk');
    expect(service.runningProcesses.has('ws-1')).toBe(false);
    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
  });

  it('swallows markFailed errors from spawn error handler', async () => {
    mockMarkFailed.mockRejectedValue(new Error('state moved'));
    const service = new RunScriptService() as unknown as {
      registerProcessHandlers: (
        workspaceId: string,
        childProcess: FakeChildProcess,
        pid: number
      ) => void;
      runningProcesses: Map<string, FakeChildProcess>;
    };
    const childProcess = new FakeChildProcess(12_345);
    service.runningProcesses.set('ws-1', childProcess);

    service.registerProcessHandlers('ws-1', childProcess, 12_345);
    childProcess.emit('error', new Error('spawn failed'));
    await flushMicrotasks();

    expect(service.runningProcesses.has('ws-1')).toBe(false);
    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
  });

  it('swallows exit-handler failures when handleProcessExit rejects', async () => {
    const service = new RunScriptService() as unknown as {
      registerProcessHandlers: (
        workspaceId: string,
        childProcess: FakeChildProcess,
        pid: number
      ) => void;
      handleProcessExit: (
        workspaceId: string,
        childProcess: FakeChildProcess,
        pid: number,
        code: number | null,
        signal: string | null
      ) => Promise<void>;
    };
    const childProcess = new FakeChildProcess(12_345);
    vi.spyOn(service, 'handleProcessExit').mockRejectedValue(new Error('exit handler failed'));

    service.registerProcessHandlers('ws-1', childProcess, 12_345);
    childProcess.emit('exit', 1, 'SIGTERM');
    await flushMicrotasks();

    expect(service.handleProcessExit).toHaveBeenCalledWith(
      'ws-1',
      childProcess,
      12_345,
      1,
      'SIGTERM'
    );
  });
});

describe('RunScriptService.stopRunScript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => callback(null)
    );
  });

  it('returns success when completeStopping races with exit handler', async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: 12_345,
        runScriptCleanupCommand: null,
        worktreePath: '/tmp/ws-1',
        runScriptPort: null,
      })
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptStatus: 'IDLE',
      });
    mockBeginStopping.mockResolvedValue(undefined);
    mockCompleteStopping.mockRejectedValue(new Error('already transitioned'));

    const service = new RunScriptService();
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', { pid: 12_345 });
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockBeginStopping).toHaveBeenCalledWith('ws-1');
    expect(mockTreeKill).toHaveBeenCalledWith(12_345, 'SIGTERM', expect.any(Function));
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
    expect(mockFindById).toHaveBeenNthCalledWith(2, 'ws-1');
  });

  it('returns error when workspace not found', async () => {
    mockFindById.mockResolvedValue(null);

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-missing');

    expect(result).toEqual({ success: false, error: 'Workspace not found' });
  });

  it('returns success immediately when already IDLE', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'IDLE' });

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockBeginStopping).not.toHaveBeenCalled();
  });

  it('reconciles STOPPING state to IDLE before returning success', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STOPPING' });
    mockCompleteStopping.mockResolvedValue(undefined);

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockBeginStopping).not.toHaveBeenCalled();
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
  });

  it('kills lingering process before completing STOPPING to IDLE', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'STOPPING',
      runScriptPid: 12_345,
    });
    mockCompleteStopping.mockResolvedValue(undefined);

    const service = new RunScriptService();
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', { pid: 12_345 });
    (service as unknown as StopHandlerCapable).postRunProcesses.set('ws-1', { pid: 888 } as never);

    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockTreeKill).toHaveBeenCalledWith(12_345, 'SIGTERM', expect.any(Function));
    expect(mockTreeKill).toHaveBeenCalledWith(888, 'SIGTERM', expect.any(Function));
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
  });

  it('handles COMPLETED state by resetting to IDLE', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'COMPLETED',
      runScriptPid: null,
    });
    mockReset.mockResolvedValue(undefined);

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockReset).toHaveBeenCalledWith('ws-1');
  });

  it('handles FAILED state by resetting to IDLE', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'FAILED',
      runScriptPid: null,
    });
    mockReset.mockResolvedValue(undefined);

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockReset).toHaveBeenCalledWith('ws-1');
  });

  it('returns error when no process or PID available for RUNNING workspace', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'RUNNING',
      runScriptPid: null,
    });

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: false, error: 'No run script is running' });
  });

  it('handles beginStopping race where state moved to COMPLETED', async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: 12_345,
        runScriptCleanupCommand: null,
        worktreePath: '/tmp/ws-1',
        runScriptPort: null,
      })
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptStatus: 'COMPLETED',
      });
    mockBeginStopping.mockRejectedValue(new Error('CAS failed'));

    const service = new RunScriptService();
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', { pid: 12_345 });
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
  });

  it('clears in-memory process entry even when tree-kill reports an error', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'RUNNING',
      runScriptPid: 12_345,
      runScriptCleanupCommand: null,
      worktreePath: '/tmp/ws-1',
      runScriptPort: null,
    });
    mockBeginStopping.mockResolvedValue(undefined);
    mockCompleteStopping.mockResolvedValue(undefined);
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) =>
        callback(new Error('ESRCH'))
    );

    const service = new RunScriptService();
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', { pid: 12_345 });
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect((service as unknown as StopHandlerCapable).runningProcesses.has('ws-1')).toBe(false);
  });

  it('uses reconciled cleanup command during stop flow', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'RUNNING',
      runScriptPid: 12_345,
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: null,
      worktreePath: '/tmp/ws-1',
      runScriptPort: 3000,
    });
    mockBeginStopping.mockResolvedValue(undefined);
    mockCompleteStopping.mockResolvedValue(undefined);
    mockReconcileWorkspaceCommandCache.mockResolvedValue({
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: 'echo cleanup {port}',
    });

    const service = new RunScriptService();
    const runCleanupSpy = vi
      .spyOn(
        service as unknown as {
          runCleanupScript: (
            workspaceId: string,
            workspace: {
              runScriptCleanupCommand: string;
              worktreePath: string;
              runScriptPort: number | null;
            }
          ) => Promise<void>;
        },
        'runCleanupScript'
      )
      .mockResolvedValue(undefined);
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', { pid: 12_345 });

    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockReconcileWorkspaceCommandCache).toHaveBeenCalledTimes(1);
    expect(runCleanupSpy).toHaveBeenCalledWith('ws-1', {
      runScriptCleanupCommand: 'echo cleanup {port}',
      worktreePath: '/tmp/ws-1',
      runScriptPort: 3000,
    });
  });

  it('falls back to cached cleanup command when reconciliation fails during stop', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'RUNNING',
      runScriptPid: 12_345,
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: 'echo cached cleanup {port}',
      worktreePath: '/tmp/ws-1',
      runScriptPort: 3000,
    });
    mockBeginStopping.mockResolvedValue(undefined);
    mockCompleteStopping.mockResolvedValue(undefined);
    mockReconcileWorkspaceCommandCache.mockRejectedValue(new Error('Invalid factory-factory.json'));

    const service = new RunScriptService();
    const runCleanupSpy = vi
      .spyOn(
        service as unknown as {
          runCleanupScript: (
            workspaceId: string,
            workspace: {
              runScriptCleanupCommand: string;
              worktreePath: string;
              runScriptPort: number | null;
            }
          ) => Promise<void>;
        },
        'runCleanupScript'
      )
      .mockResolvedValue(undefined);
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', { pid: 12_345 });

    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(runCleanupSpy).toHaveBeenCalledWith('ws-1', {
      runScriptCleanupCommand: 'echo cached cleanup {port}',
      worktreePath: '/tmp/ws-1',
      runScriptPort: 3000,
    });
    expect(mockTreeKill).toHaveBeenCalledWith(12_345, 'SIGTERM', expect.any(Function));
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
  });

  it('waits for tracked process exit before completing STOPPING', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'RUNNING',
      runScriptPid: 12_345,
      runScriptCleanupCommand: null,
      worktreePath: '/tmp/ws-1',
      runScriptPort: null,
    });
    mockBeginStopping.mockResolvedValue(undefined);
    mockCompleteStopping.mockResolvedValue(undefined);

    let exitHandler: ((code: number | null, signal: string | null) => void) | undefined;
    const mockProcess: {
      pid: number;
      exitCode: number | null;
      once: (event: string, handler: (code: number | null, signal: string | null) => void) => void;
      off: (event: string, handler: (code: number | null, signal: string | null) => void) => void;
    } = {
      pid: 12_345,
      exitCode: null,
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            exitHandler = handler;
          }
        }
      ),
      off: vi.fn(),
    };

    const service = new RunScriptService();
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', mockProcess as never);

    const stopPromise = service.stopRunScript('ws-1');
    const resultBeforeExit = await Promise.race([
      stopPromise.then(() => 'resolved'),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 0);
      }),
    ]);

    expect(resultBeforeExit).toBe('pending');
    expect(mockCompleteStopping).not.toHaveBeenCalled();

    mockProcess.exitCode = 0;
    exitHandler?.(0, null);

    const result = await stopPromise;

    expect(result).toEqual({ success: true });
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
  });
});

describe('RunScriptService.handleProcessExit edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks COMPLETED on exit code 0 from RUNNING state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkCompleted.mockResolvedValue(undefined);

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', { pid: 12_345 }, 12_345, 0, null);

    expect(mockMarkCompleted).toHaveBeenCalledWith('ws-1');
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('marks FAILED on non-zero exit code from RUNNING state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkFailed.mockResolvedValue(undefined);

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', { pid: 12_345 }, 12_345, 1, null);

    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('marks FAILED on signal-killed process (null exit code)', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkFailed.mockResolvedValue(undefined);

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', { pid: 12_345 }, 12_345, null, 'SIGKILL');

    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
  });

  it('skips transition when already in IDLE state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'IDLE' });

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', { pid: 12_345 }, 12_345, 0, null);

    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockCompleteStopping).not.toHaveBeenCalled();
  });

  it('skips transition when already in COMPLETED state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'COMPLETED' });

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', { pid: 12_345 }, 12_345, 0, null);

    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('skips transition when already in FAILED state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'FAILED' });

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', { pid: 12_345 }, 12_345, 1, null);

    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('swallows state machine errors during exit handling', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkCompleted.mockRejectedValue(new Error('CAS conflict'));

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await expect(
      service.handleProcessExit('ws-1', { pid: 12_345 }, 12_345, 0, null)
    ).resolves.toBeUndefined();
  });
});

describe('RunScriptService.transitionToRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cleans up proxy tunnel when process exits during tunnel startup', async () => {
    let resolveTunnel: ((value: string | null) => void) | undefined;
    mockMarkRunning.mockResolvedValue(undefined);
    mockEnsureTunnel.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveTunnel = resolve;
        })
    );

    const service = new RunScriptService() as unknown as TransitionToRunningCapable;
    const childProcess = { pid: 12_345, exitCode: null };
    service.runningProcesses.set('ws-1', childProcess);

    const transitionPromise = service.transitionToRunning('ws-1', childProcess, 12_345, 5173);

    await Promise.resolve();
    service.runningProcesses.delete('ws-1');
    resolveTunnel?.('https://example.trycloudflare.com?token=abc123');

    const result = await transitionPromise;

    expect(mockMarkRunning).toHaveBeenCalledWith('ws-1', { pid: 12_345, port: 5173 });
    expect(mockEnsureTunnel).toHaveBeenCalledWith('ws-1', 5173);
    expect(mockStopTunnel).toHaveBeenCalledWith('ws-1');
    expect(result).toMatchObject({ success: true, port: 5173, pid: 12_345 });
    expect(result.proxyUrl).toBeUndefined();
  });

  it('starts postRun using reconciled command arguments', async () => {
    mockMarkRunning.mockResolvedValue(undefined);

    const service = new RunScriptService() as unknown as TransitionToRunningCapable & {
      spawnPostRunScript: (
        workspaceId: string,
        runScriptPostRunCommand: string,
        worktreePath: string,
        port: number | undefined
      ) => Promise<void>;
    };
    const spawnPostRunSpy = vi.spyOn(service, 'spawnPostRunScript').mockResolvedValue(undefined);
    const childProcess = { pid: 12_345, exitCode: null };
    service.runningProcesses.set('ws-1', childProcess);

    const result = await service.transitionToRunning(
      'ws-1',
      childProcess,
      12_345,
      undefined,
      'echo post-run',
      '/tmp/ws-1'
    );

    expect(result).toMatchObject({ success: true, pid: 12_345 });
    expect(spawnPostRunSpy).toHaveBeenCalledWith('ws-1', 'echo post-run', '/tmp/ws-1', undefined);
  });

  it('keeps transition successful when postRun setup throws synchronously', async () => {
    mockMarkRunning.mockResolvedValue(undefined);
    mockEnsureTunnel.mockResolvedValue(null);
    const substitutePortSpy = vi
      .spyOn(FactoryConfigService, 'substitutePort')
      .mockImplementation(() => {
        throw new Error('bad postRun command');
      });

    const service = new RunScriptService() as unknown as TransitionToRunningCapable;
    const childProcess = { pid: 12_345, exitCode: null };
    service.runningProcesses.set('ws-1', childProcess);

    const result = await service.transitionToRunning(
      'ws-1',
      childProcess,
      12_345,
      5173,
      'echo {port}',
      '/tmp/ws-1'
    );

    expect(result).toMatchObject({ success: true, port: 5173, pid: 12_345 });
    expect(mockFindById).not.toHaveBeenCalled();
    substitutePortSpy.mockRestore();
  });
});

describe('RunScriptService.appendOutput', () => {
  it('truncates output buffer when exceeding MAX_OUTPUT_BUFFER_SIZE', () => {
    const service = new RunScriptService();
    const appendOutput = (
      service as unknown as { appendOutput: (id: string, data: string) => void }
    ).appendOutput.bind(service);

    // Build a string just over 500KB
    const bigChunk = 'x'.repeat(400 * 1024);
    appendOutput('ws-1', bigChunk);

    const smallChunk = 'y'.repeat(200 * 1024);
    appendOutput('ws-1', smallChunk);

    const buffer = service.getOutputBuffer('ws-1');
    // Buffer should be capped at 500KB
    expect(buffer.length).toBe(500 * 1024);
    // Should contain the latest data
    expect(buffer.endsWith('y'.repeat(200 * 1024))).toBe(true);
  });

  it('notifies listeners on new output', () => {
    const service = new RunScriptService();
    const appendOutput = (
      service as unknown as { appendOutput: (id: string, data: string) => void }
    ).appendOutput.bind(service);
    const listener = vi.fn();
    service.subscribeToOutput('ws-1', listener);

    appendOutput('ws-1', 'hello');
    expect(listener).toHaveBeenCalledWith('hello');
  });

  it('returns empty string for unknown workspace', () => {
    const service = new RunScriptService();
    expect(service.getOutputBuffer('unknown')).toBe('');
  });
});

describe('RunScriptService.subscribeToOutput', () => {
  it('returns unsubscribe function that stops notifications', () => {
    const service = new RunScriptService();
    const appendOutput = (
      service as unknown as { appendOutput: (id: string, data: string) => void }
    ).appendOutput.bind(service);
    const listener = vi.fn();
    const unsub = service.subscribeToOutput('ws-1', listener);

    appendOutput('ws-1', 'before');
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    appendOutput('ws-1', 'after');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('cleans up listener set when last listener unsubscribes', () => {
    const service = new RunScriptService();
    const outputListeners = (service as unknown as { outputListeners: Map<string, Set<unknown>> })
      .outputListeners;

    const unsub = service.subscribeToOutput('ws-1', vi.fn());
    expect(outputListeners.has('ws-1')).toBe(true);

    unsub();
    expect(outputListeners.has('ws-1')).toBe(false);
  });
});

describe('RunScriptService.cleanupSync', () => {
  it('force kills all running processes and clears maps', () => {
    const service = new RunScriptService();
    const mockProcess = { killed: false, kill: vi.fn(), pid: 999 };
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', mockProcess as never);

    service.cleanupSync();

    expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    expect((service as unknown as StopHandlerCapable).runningProcesses.size).toBe(0);
    expect(mockCleanupTunnelsSync).toHaveBeenCalledTimes(1);
  });

  it('skips already-killed processes', () => {
    const service = new RunScriptService();
    const mockProcess = { killed: true, kill: vi.fn(), pid: 999 };
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', mockProcess as never);

    service.cleanupSync();

    expect(mockProcess.kill).not.toHaveBeenCalled();
  });

  it('force kills postRun processes on sync cleanup', () => {
    const service = new RunScriptService();
    const mockPostRun = { killed: false, kill: vi.fn(), pid: 888 };
    (service as unknown as StopHandlerCapable).postRunProcesses.set('ws-1', mockPostRun as never);

    service.cleanupSync();

    expect(mockPostRun.kill).toHaveBeenCalledWith('SIGKILL');
    expect((service as unknown as StopHandlerCapable).postRunProcesses.size).toBe(0);
  });

  it('skips already-killed postRun processes', () => {
    const service = new RunScriptService();
    const mockPostRun = { killed: true, kill: vi.fn(), pid: 888 };
    (service as unknown as StopHandlerCapable).postRunProcesses.set('ws-1', mockPostRun as never);

    service.cleanupSync();

    expect(mockPostRun.kill).not.toHaveBeenCalled();
    expect((service as unknown as StopHandlerCapable).postRunProcesses.size).toBe(0);
  });
});

describe('RunScriptService.killPostRunProcess', () => {
  type KillPostRunCapable = {
    killPostRunProcess: (workspaceId: string) => Promise<void>;
    postRunProcesses: Map<string, { pid: number }>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when no postRun process exists', async () => {
    const service = new RunScriptService() as unknown as KillPostRunCapable;
    await service.killPostRunProcess('ws-1');
    expect(mockTreeKill).not.toHaveBeenCalled();
  });

  it('cleans up postRun process without pid', async () => {
    const service = new RunScriptService() as unknown as KillPostRunCapable;
    service.postRunProcesses.set('ws-1', { pid: 0 } as never);

    await service.killPostRunProcess('ws-1');

    expect(mockTreeKill).not.toHaveBeenCalled();
    expect(service.postRunProcesses.has('ws-1')).toBe(false);
  });

  it('tree-kills postRun process by pid', async () => {
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => callback(null)
    );

    const service = new RunScriptService() as unknown as KillPostRunCapable;
    service.postRunProcesses.set('ws-1', { pid: 888 } as never);

    await service.killPostRunProcess('ws-1');

    expect(mockTreeKill).toHaveBeenCalledWith(888, 'SIGTERM', expect.any(Function));
    expect(service.postRunProcesses.has('ws-1')).toBe(false);
  });

  it('handles ESRCH error gracefully when postRun process already exited', async () => {
    const esrchError = new Error('No such process') as NodeJS.ErrnoException;
    esrchError.code = 'ESRCH';
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) =>
        callback(esrchError)
    );

    const service = new RunScriptService() as unknown as KillPostRunCapable;
    service.postRunProcesses.set('ws-1', { pid: 888 } as never);

    await service.killPostRunProcess('ws-1');

    expect(service.postRunProcesses.has('ws-1')).toBe(false);
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

describe('RunScriptService.evictWorkspaceBuffers', () => {
  type BufferEvictionCapable = {
    outputBuffers: Map<string, string>;
    outputListeners: Map<string, Set<(data: string) => void>>;
    postRunOutputBuffers: Map<string, string>;
    postRunOutputListeners: Map<string, Set<(data: string) => void>>;
    evictWorkspaceBuffers: (workspaceId: string) => void;
  };

  it('evicts output and listener buffers for an archived workspace only', () => {
    const service = new RunScriptService() as unknown as BufferEvictionCapable;
    service.outputBuffers.set('ws-1', 'main logs');
    service.postRunOutputBuffers.set('ws-1', 'postRun logs');
    service.outputListeners.set('ws-1', new Set([vi.fn()]));
    service.postRunOutputListeners.set('ws-1', new Set([vi.fn()]));

    service.outputBuffers.set('ws-2', 'keep');
    service.postRunOutputBuffers.set('ws-2', 'keep');
    service.outputListeners.set('ws-2', new Set([vi.fn()]));
    service.postRunOutputListeners.set('ws-2', new Set([vi.fn()]));

    service.evictWorkspaceBuffers('ws-1');

    expect(service.outputBuffers.has('ws-1')).toBe(false);
    expect(service.postRunOutputBuffers.has('ws-1')).toBe(false);
    expect(service.outputListeners.has('ws-1')).toBe(false);
    expect(service.postRunOutputListeners.has('ws-1')).toBe(false);

    expect(service.outputBuffers.has('ws-2')).toBe(true);
    expect(service.postRunOutputBuffers.has('ws-2')).toBe(true);
    expect(service.outputListeners.has('ws-2')).toBe(true);
    expect(service.postRunOutputListeners.has('ws-2')).toBe(true);
  });
});

describe('RunScriptService.postRun output helpers', () => {
  it('appends postRun output and notifies postRun listeners', () => {
    const service = new RunScriptService() as unknown as {
      appendPostRunOutput: (workspaceId: string, output: string) => void;
      subscribeToPostRunOutput: (
        workspaceId: string,
        listener: (data: string) => void
      ) => () => void;
      getPostRunOutputBuffer: (workspaceId: string) => string;
    };
    const listener = vi.fn();
    const unsubscribe = service.subscribeToPostRunOutput('ws-1', listener);

    service.appendPostRunOutput('ws-1', 'hello');
    expect(listener).toHaveBeenCalledWith('hello');
    expect(service.getPostRunOutputBuffer('ws-1')).toContain('hello');

    unsubscribe();
    service.appendPostRunOutput('ws-1', 'again');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('truncates oversized postRun buffers and returns empty for unknown workspaces', () => {
    const service = new RunScriptService() as unknown as {
      appendPostRunOutput: (workspaceId: string, output: string) => void;
      getPostRunOutputBuffer: (workspaceId: string) => string;
    };
    service.appendPostRunOutput('ws-1', 'x'.repeat(450 * 1024));
    service.appendPostRunOutput('ws-1', 'y'.repeat(200 * 1024));

    const buffer = service.getPostRunOutputBuffer('ws-1');
    expect(buffer.length).toBe(500 * 1024);
    expect(buffer.endsWith('y'.repeat(200 * 1024))).toBe(true);
    expect(service.getPostRunOutputBuffer('unknown')).toBe('');
  });
});

describe('RunScriptService.transition/start helper methods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns tunnel URL when process is still active after tunnel starts', async () => {
    mockEnsureTunnel.mockResolvedValue('https://example.trycloudflare.com');
    const service = new RunScriptService() as unknown as {
      ensureTunnelForActiveProcess: (
        workspaceId: string,
        childProcess: FakeChildProcess,
        pid: number,
        port: number
      ) => Promise<string | null>;
      runningProcesses: Map<string, FakeChildProcess>;
    };
    const childProcess = new FakeChildProcess(12_345);
    service.runningProcesses.set('ws-1', childProcess);

    await expect(
      service.ensureTunnelForActiveProcess('ws-1', childProcess, 12_345, 5173)
    ).resolves.toBe('https://example.trycloudflare.com');
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  it('handles markRunning races for completed/failed states', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'COMPLETED' });
    const service = new RunScriptService() as unknown as {
      handleMarkRunningRace: (
        workspaceId: string,
        childProcess: FakeChildProcess,
        pid: number,
        port: number | undefined,
        markRunningError: unknown
      ) => Promise<{ success: boolean; port?: number; pid?: number; error?: string }>;
    };

    const result = await service.handleMarkRunningRace(
      'ws-1',
      new FakeChildProcess(12_345),
      12_345,
      5173,
      new Error('CAS failed')
    );

    expect(result).toEqual({ success: true, port: 5173, pid: 12_345 });
  });

  it('kills orphaned process when stop wins markRunning race', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'IDLE' });
    const service = new RunScriptService() as unknown as {
      handleMarkRunningRace: (
        workspaceId: string,
        childProcess: FakeChildProcess,
        pid: number,
        port: number | undefined,
        markRunningError: unknown
      ) => Promise<{ success: boolean; port?: number; pid?: number; error?: string }>;
      runningProcesses: Map<string, FakeChildProcess>;
    };
    const childProcess = new FakeChildProcess(12_345);
    childProcess.kill.mockImplementation(() => {
      throw new Error('already exited');
    });
    service.runningProcesses.set('ws-1', childProcess);

    const result = await service.handleMarkRunningRace(
      'ws-1',
      childProcess,
      12_345,
      undefined,
      new Error('CAS failed')
    );

    expect(result).toEqual({
      success: false,
      error: 'Run script was stopped before it could start',
    });
    expect(service.runningProcesses.has('ws-1')).toBe(false);
  });

  it('rethrows markRunning race errors for unexpected states', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    const service = new RunScriptService() as unknown as {
      handleMarkRunningRace: (
        workspaceId: string,
        childProcess: FakeChildProcess,
        pid: number,
        port: number | undefined,
        markRunningError: unknown
      ) => Promise<unknown>;
    };
    const markRunningError = new Error('unexpected');

    await expect(
      service.handleMarkRunningRace(
        'ws-1',
        new FakeChildProcess(12_345),
        12_345,
        undefined,
        markRunningError
      )
    ).rejects.toThrow(markRunningError);
  });

  it('marks failed from handleStartError when workspace is still STARTING', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STARTING' });
    mockMarkFailed.mockResolvedValue(undefined);
    const service = new RunScriptService() as unknown as {
      handleStartError: (
        workspaceId: string,
        error: Error
      ) => Promise<{ success: boolean; error?: string }>;
    };

    const result = await service.handleStartError('ws-1', new Error('bad start'));

    expect(result).toEqual({ success: false, error: 'bad start' });
    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
  });

  it('swallows markFailed errors inside handleStartError', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STARTING' });
    mockMarkFailed.mockRejectedValue(new Error('db conflict'));
    const service = new RunScriptService() as unknown as {
      handleStartError: (
        workspaceId: string,
        error: Error
      ) => Promise<{ success: boolean; error?: string }>;
    };

    await expect(service.handleStartError('ws-1', new Error('bad start'))).resolves.toEqual({
      success: false,
      error: 'bad start',
    });
  });
});

describe('RunScriptService.cleanup/postRun internals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => callback(null)
    );
  });

  it('runs cleanup script with substituted port and handles stream errors', async () => {
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
    cleanupProcess.stdout.emit('error', new Error('stdout fail'));
    cleanupProcess.stderr.emit('error', new Error('stderr fail'));
    cleanupProcess.emit('exit', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith('bash', ['-c', 'echo cleanup 3000'], {
      cwd: '/tmp/ws-1',
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
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

  it('spawns postRun process, captures output, and cleans map on exit', async () => {
    const postRunProcess = new FakeChildProcess(88_888);
    mockSpawn.mockReturnValue(postRunProcess);
    const service = new RunScriptService() as unknown as {
      spawnPostRunScript: (
        workspaceId: string,
        runScriptPostRunCommand: string,
        worktreePath: string,
        port: number | undefined
      ) => Promise<void>;
      postRunProcesses: Map<string, FakeChildProcess>;
      getPostRunOutputBuffer: (workspaceId: string) => string;
    };

    await service.spawnPostRunScript('ws-1', 'echo postrun {port}', '/tmp/ws-1', 3000);
    expect(mockSpawn).toHaveBeenCalledWith('bash', ['-c', 'echo postrun 3000'], {
      cwd: '/tmp/ws-1',
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(service.postRunProcesses.get('ws-1')).toBe(postRunProcess);

    postRunProcess.stdout.emit('data', Buffer.from('post stdout'));
    postRunProcess.stderr.emit('data', Buffer.from('post stderr'));
    postRunProcess.stdout.emit('error', new Error('stdout fail'));
    postRunProcess.stderr.emit('error', new Error('stderr fail'));
    expect(service.getPostRunOutputBuffer('ws-1')).toContain('post stdout');
    expect(service.getPostRunOutputBuffer('ws-1')).toContain('post stderr');

    postRunProcess.emit('exit', 0, null);
    expect(service.postRunProcesses.has('ws-1')).toBe(false);
  });

  it('removes postRun process from map on spawn error', async () => {
    const postRunProcess = new FakeChildProcess(88_888);
    mockSpawn.mockReturnValue(postRunProcess);
    const service = new RunScriptService() as unknown as {
      spawnPostRunScript: (
        workspaceId: string,
        runScriptPostRunCommand: string,
        worktreePath: string,
        port: number | undefined
      ) => Promise<void>;
      postRunProcesses: Map<string, FakeChildProcess>;
    };

    await service.spawnPostRunScript('ws-1', 'echo postrun', '/tmp/ws-1', undefined);
    expect(service.postRunProcesses.has('ws-1')).toBe(true);

    postRunProcess.emit('error', new Error('spawn failed'));
    expect(service.postRunProcesses.has('ws-1')).toBe(false);
  });

  it('returns early when postRun process cannot provide a pid', async () => {
    mockSpawn.mockReturnValue(new FakeChildProcess(undefined));
    const service = new RunScriptService() as unknown as {
      spawnPostRunScript: (
        workspaceId: string,
        runScriptPostRunCommand: string,
        worktreePath: string,
        port: number | undefined
      ) => Promise<void>;
      postRunProcesses: Map<string, FakeChildProcess>;
    };

    await service.spawnPostRunScript('ws-1', 'echo postrun', '/tmp/ws-1', undefined);
    expect(service.postRunProcesses.has('ws-1')).toBe(false);
  });

  it('warns and still clears map when tree-kill postRun fails unexpectedly', async () => {
    const epermError = new Error('Operation not permitted') as NodeJS.ErrnoException;
    epermError.code = 'EPERM';
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) =>
        callback(epermError)
    );
    const service = new RunScriptService() as unknown as {
      killPostRunProcess: (workspaceId: string) => Promise<void>;
      postRunProcesses: Map<string, FakeChildProcess>;
    };
    service.postRunProcesses.set('ws-1', new FakeChildProcess(88_888));

    await service.killPostRunProcess('ws-1');

    expect(service.postRunProcesses.has('ws-1')).toBe(false);
  });
});

describe('RunScriptService.stop-flow helper methods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => callback(null)
    );
  });

  it('rethrows beginStopping errors when fresh status is not terminal', async () => {
    mockBeginStopping.mockRejectedValue(new Error('CAS failed'));
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    const service = new RunScriptService() as unknown as {
      attemptBeginStopping: (workspaceId: string) => Promise<boolean>;
    };

    await expect(service.attemptBeginStopping('ws-1')).rejects.toThrow('CAS failed');
  });

  it('rethrows completeStopping errors when workspace is not IDLE', async () => {
    mockCompleteStopping.mockRejectedValue(new Error('CAS failed'));
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    const service = new RunScriptService() as unknown as {
      completeStoppingAfterStop: (workspaceId: string) => Promise<void>;
    };

    await expect(service.completeStoppingAfterStop('ws-1')).rejects.toThrow('CAS failed');
  });

  it('kills orphaned terminal child process and swallows reset races', async () => {
    mockReset.mockRejectedValue(new Error('already reset'));
    const service = new RunScriptService() as unknown as {
      handleTerminalStateStop: (
        workspaceId: string,
        childProcess: FakeChildProcess | undefined
      ) => Promise<{ success: boolean }>;
      runningProcesses: Map<string, FakeChildProcess>;
    };
    const orphan = new FakeChildProcess(99_999);
    orphan.kill.mockImplementation(() => {
      throw new Error('already dead');
    });
    service.runningProcesses.set('ws-1', orphan);

    const result = await service.handleTerminalStateStop('ws-1', orphan);

    expect(result).toEqual({ success: true });
    expect(service.runningProcesses.has('ws-1')).toBe(false);
  });

  it('returns when killProcessTree has no target pid', async () => {
    const service = new RunScriptService() as unknown as {
      killProcessTree: (
        workspaceId: string,
        childProcess: FakeChildProcess | undefined,
        pid: number | null
      ) => Promise<void>;
    };

    await expect(service.killProcessTree('ws-1', undefined, null)).resolves.toBeUndefined();
    expect(mockTreeKill).not.toHaveBeenCalled();
  });

  it('handles ESRCH errors during tree-kill in killProcessTree', async () => {
    const esrchError = new Error('No such process') as NodeJS.ErrnoException;
    esrchError.code = 'ESRCH';
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) =>
        callback(esrchError)
    );
    const service = new RunScriptService() as unknown as {
      killProcessTree: (
        workspaceId: string,
        childProcess: FakeChildProcess | undefined,
        pid: number | null
      ) => Promise<void>;
      runningProcesses: Map<string, FakeChildProcess>;
    };
    const running = new FakeChildProcess(12_345);
    service.runningProcesses.set('ws-1', running);

    await service.killProcessTree('ws-1', running, null);
    expect(service.runningProcesses.has('ws-1')).toBe(false);
  });
});

describe('RunScriptService.waitForProcessExit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns immediately when no process is provided', async () => {
    const service = new RunScriptService() as unknown as {
      waitForProcessExit: (
        workspaceId: string,
        childProcess: FakeChildProcess | undefined,
        pid: number | null
      ) => Promise<void>;
    };

    await expect(service.waitForProcessExit('ws-1', undefined, 12_345)).resolves.toBeUndefined();
  });

  it('returns when process already has exitCode', async () => {
    const service = new RunScriptService() as unknown as {
      waitForProcessExit: (
        workspaceId: string,
        childProcess: FakeChildProcess | undefined,
        pid: number | null
      ) => Promise<void>;
    };
    const childProcess = new FakeChildProcess(12_345);
    childProcess.exitCode = 0;

    await expect(service.waitForProcessExit('ws-1', childProcess, 12_345)).resolves.toBeUndefined();
  });

  it('returns when child process does not expose once/off', async () => {
    const service = new RunScriptService() as unknown as {
      waitForProcessExit: (
        workspaceId: string,
        childProcess: { pid: number; exitCode: number | null },
        pid: number | null
      ) => Promise<void>;
    };

    await expect(
      service.waitForProcessExit('ws-1', { pid: 12_345, exitCode: null }, 12_345)
    ).resolves.toBeUndefined();
  });

  it('resolves when wait listener receives process error event', async () => {
    const service = new RunScriptService() as unknown as {
      waitForProcessExit: (
        workspaceId: string,
        childProcess: FakeChildProcess | undefined,
        pid: number | null
      ) => Promise<void>;
    };
    const childProcess = new FakeChildProcess(12_345);

    const waitPromise = service.waitForProcessExit('ws-1', childProcess, 12_345);
    childProcess.emit('error', new Error('process stream error'));
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('resolves on timeout while waiting for process exit', async () => {
    vi.useFakeTimers();
    const service = new RunScriptService() as unknown as {
      waitForProcessExit: (
        workspaceId: string,
        childProcess: FakeChildProcess | undefined,
        pid: number | null
      ) => Promise<void>;
    };
    const childProcess = new FakeChildProcess(12_345);

    const waitPromise = service.waitForProcessExit('ws-1', childProcess, 12_345);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(waitPromise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('resolves immediately when exitCode flips after listeners are attached', async () => {
    const service = new RunScriptService() as unknown as {
      waitForProcessExit: (
        workspaceId: string,
        childProcess: FakeChildProcess | undefined,
        pid: number | null
      ) => Promise<void>;
    };
    const childProcess = new FakeChildProcess(12_345);
    const onceSpy = vi.spyOn(childProcess, 'once');
    onceSpy.mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      EventEmitter.prototype.once.call(childProcess, event, listener);
      childProcess.exitCode = 0;
      return childProcess;
    }) as typeof childProcess.once);

    await expect(service.waitForProcessExit('ws-1', childProcess, 12_345)).resolves.toBeUndefined();
  });
});

describe('RunScriptService.cleanup + shutdown handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('continues cleanup when one stopRunScript call rejects', async () => {
    const service = new RunScriptService() as unknown as {
      runningProcesses: Map<string, FakeChildProcess>;
      postRunProcesses: Map<string, FakeChildProcess>;
      stopRunScript: (workspaceId: string) => Promise<{ success: boolean }>;
      cleanup: () => Promise<void>;
    };
    service.runningProcesses.set('ws-1', new FakeChildProcess(1));
    service.runningProcesses.set('ws-2', new FakeChildProcess(2));
    service.postRunProcesses.set('ws-1', new FakeChildProcess(11));
    vi.spyOn(service, 'stopRunScript')
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('failed to stop'));
    mockCleanupTunnels.mockResolvedValue(undefined);

    await service.cleanup();

    expect(service.stopRunScript).toHaveBeenCalledWith('ws-1');
    expect(service.stopRunScript).toHaveBeenCalledWith('ws-2');
    expect(service.runningProcesses.size).toBe(0);
    expect(service.postRunProcesses.size).toBe(0);
    expect(mockCleanupTunnels).toHaveBeenCalledTimes(1);
  });

  it('registers shutdown handlers once and runs cleanup hooks', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...args: unknown[]) => unknown
    ) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on);

    const service = new RunScriptService() as unknown as {
      registerShutdownHandlers: () => void;
      cleanup: () => Promise<void>;
      cleanupSync: () => void;
    };
    const cleanupSpy = vi.spyOn(service, 'cleanup').mockResolvedValue(undefined);
    const cleanupSyncSpy = vi.spyOn(service, 'cleanupSync').mockImplementation(() => undefined);

    service.registerShutdownHandlers();
    service.registerShutdownHandlers();
    expect(processOnSpy).toHaveBeenCalledTimes(3);

    await (handlers.get('SIGINT') as () => Promise<void>)();
    await flushMicrotasks();
    await (handlers.get('SIGINT') as () => Promise<void>)();
    await flushMicrotasks();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    const secondService = new RunScriptService() as unknown as {
      registerShutdownHandlers: () => void;
      cleanupSync: () => void;
    };
    const secondCleanupSyncSpy = vi
      .spyOn(secondService, 'cleanupSync')
      .mockImplementation(() => undefined);
    secondService.registerShutdownHandlers();
    (handlers.get('exit') as () => void)();

    expect(cleanupSyncSpy).toHaveBeenCalledTimes(0);
    expect(secondCleanupSyncSpy).toHaveBeenCalledTimes(1);
  });

  it('runs SIGTERM cleanup and skips second invocation after shutdown begins', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...args: unknown[]) => unknown
    ) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on);
    const service = new RunScriptService() as unknown as {
      registerShutdownHandlers: () => void;
      cleanup: () => Promise<void>;
    };
    const cleanupSpy = vi.spyOn(service, 'cleanup').mockResolvedValue(undefined);
    service.registerShutdownHandlers();

    await (handlers.get('SIGTERM') as () => Promise<void>)();
    await (handlers.get('SIGTERM') as () => Promise<void>)();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});
