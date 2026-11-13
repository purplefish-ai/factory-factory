import './run-script-legacy.test-support';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  spawnOwnedPostRun,
  FakeChildProcess,
  flushMicrotasks,
  captureShutdownHandlers,
  installExecution,
  serviceExecutions,
  mockSpawn,
  mockTreeKill,
  mockFindById,
  mockBeginStopping,
  mockCompleteStopping,
  mockReset,
  mockCleanupTunnels,
  mockCleanupTunnelsSync,
  mockReconcileWorkspaceCommandCache,
} from './run-script-legacy.test-support';
import { RunScriptService } from './run-script.service';

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
    installExecution(service, 'ws-1', { pid: 12_345 });
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockBeginStopping).toHaveBeenCalledWith('ws-1');
    expect(mockTreeKill).toHaveBeenCalledWith(12_345, 'SIGTERM', expect.any(Function));
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
    expect(mockFindById).toHaveBeenNthCalledWith(2, 'ws-1');
  });

  it('keeps output listeners when controlled tree-kill completes before exit', async () => {
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
    const service = new RunScriptService();
    const childProcess = new FakeChildProcess(12_345);
    childProcess.exitCode = 0;
    const listener = vi.fn();
    const execution = installExecution(service, 'ws-1');
    mockSpawn.mockReturnValueOnce(childProcess);
    execution.spawn('echo main', '/tmp/ws-1');
    service.subscribeToOutput('ws-1', listener);

    const result = await service.stopRunScript('ws-1');
    childProcess.stdout.emit('data', Buffer.from('next run output'));

    expect(result).toEqual({ success: true });
    expect(serviceExecutions(service).has('ws-1')).toBe(false);
    expect(listener).toHaveBeenCalledWith('next run output');
  });

  it('retains controlled-stop evidence when completing STOPPING fails', async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: 12_345,
        runScriptCleanupCommand: null,
        worktreePath: '/tmp/ws-1',
        runScriptPort: null,
      })
      .mockResolvedValueOnce({ id: 'ws-1', runScriptStatus: 'STOPPING' });
    mockBeginStopping.mockResolvedValue(undefined);
    mockCompleteStopping.mockRejectedValue(new Error('database unavailable'));
    const service = new RunScriptService();
    const childProcess = new FakeChildProcess(12_345);
    childProcess.exitCode = 0;
    const listener = vi.fn();
    const execution = installExecution(service, 'ws-1');
    mockSpawn.mockReturnValueOnce(childProcess);
    execution.spawn('echo main', '/tmp/ws-1');
    service.subscribeToOutput('ws-1', listener);

    const result = await service.stopRunScript('ws-1');
    childProcess.stdout.emit('data', Buffer.from('still retained'));

    expect(result).toEqual({ success: false, error: 'database unavailable' });
    expect(serviceExecutions(service).get('ws-1')?.process).toBe(childProcess);
    expect(listener).toHaveBeenCalledWith('still retained');
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
    installExecution(service, 'ws-1', { pid: 12_345 });
    await spawnOwnedPostRun(serviceExecutions(service).get('ws-1')!, new FakeChildProcess(888));

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

  it('returns success and transitions to IDLE when stopping STARTING with no process', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'STARTING',
      runScriptPid: null,
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: null,
      worktreePath: '/tmp/ws-1',
      runScriptPort: null,
    });
    mockBeginStopping.mockResolvedValue(undefined);
    mockCompleteStopping.mockResolvedValue(undefined);

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockBeginStopping).toHaveBeenCalledWith('ws-1');
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
    expect(mockTreeKill).not.toHaveBeenCalled();
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
    installExecution(service, 'ws-1', { pid: 12_345 });
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
    installExecution(service, 'ws-1', { pid: 12_345 });
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(serviceExecutions(service).has('ws-1')).toBe(false);
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
    installExecution(service, 'ws-1', { pid: 12_345 });

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
    installExecution(service, 'ws-1', { pid: 12_345 });

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
      signalCode: NodeJS.Signals | null;
      once: (event: string, handler: (code: number | null, signal: string | null) => void) => void;
      off: (event: string, handler: (code: number | null, signal: string | null) => void) => void;
    } = {
      pid: 12_345,
      exitCode: null,
      signalCode: null,
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
    installExecution(service, 'ws-1', mockProcess as never);

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
    const service = new RunScriptService();
    const orphan = new FakeChildProcess(99_999);
    orphan.kill.mockImplementation(() => {
      throw new Error('already dead');
    });
    installExecution(service, 'ws-1', orphan);
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'COMPLETED' });

    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(serviceExecutions(service).has('ws-1')).toBe(false);
  });
});
describe('RunScriptService.cleanupSync', () => {
  it('force kills all running processes and clears maps', () => {
    const service = new RunScriptService();
    const mockProcess = { killed: false, kill: vi.fn(), pid: 999 };
    installExecution(service, 'ws-1', mockProcess as never);

    service.cleanupSync();

    expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    expect(serviceExecutions(service).size).toBe(0);
    expect(mockCleanupTunnelsSync).toHaveBeenCalledTimes(1);
  });

  it('skips already-killed processes', () => {
    const service = new RunScriptService();
    const mockProcess = { killed: true, kill: vi.fn(), pid: 999 };
    installExecution(service, 'ws-1', mockProcess as never);

    service.cleanupSync();

    expect(mockProcess.kill).not.toHaveBeenCalled();
  });

  it('force kills postRun processes on sync cleanup', async () => {
    const service = new RunScriptService();
    const mockPostRun = { killed: false, kill: vi.fn(), pid: 888 };
    const execution = installExecution(service, 'ws-1', new FakeChildProcess(12_345));
    await spawnOwnedPostRun(execution, mockPostRun);

    service.cleanupSync();

    expect(mockPostRun.kill).toHaveBeenCalledWith('SIGKILL');
    expect(serviceExecutions(service).size).toBe(0);
  });

  it('skips already-killed postRun processes', async () => {
    const service = new RunScriptService();
    const mockPostRun = { killed: true, kill: vi.fn(), pid: 888 };
    const execution = installExecution(service, 'ws-1', new FakeChildProcess(12_345));
    await spawnOwnedPostRun(execution, mockPostRun);

    service.cleanupSync();

    expect(mockPostRun.kill).not.toHaveBeenCalled();
    expect(serviceExecutions(service).size).toBe(0);
  });
});

describe('RunScriptService.cleanup + shutdown handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('continues cleanup when one stopRunScript call rejects', async () => {
    const service = new RunScriptService();
    installExecution(service, 'ws-1', new FakeChildProcess(1));
    installExecution(service, 'ws-2', new FakeChildProcess(2));
    await spawnOwnedPostRun(serviceExecutions(service).get('ws-1')!, new FakeChildProcess(11));
    vi.spyOn(service, 'stopRunScript')
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('failed to stop'));
    mockCleanupTunnels.mockResolvedValue(undefined);

    await service.cleanup();

    expect(service.stopRunScript).toHaveBeenCalledWith('ws-1');
    expect(service.stopRunScript).toHaveBeenCalledWith('ws-2');
    expect(serviceExecutions(service).size).toBe(0);
    expect(mockCleanupTunnels).toHaveBeenCalledTimes(1);
  });

  it('shares in-flight cleanup work between concurrent callers', async () => {
    const service = new RunScriptService();
    installExecution(service, 'ws-1', new FakeChildProcess(1));
    let finishStop!: () => void;
    const stopCanFinish = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const stopRunScriptSpy = vi.spyOn(service, 'stopRunScript').mockImplementation(async () => {
      await stopCanFinish;
      return { success: true };
    });
    mockCleanupTunnels.mockResolvedValue(undefined);

    const firstCleanup = service.cleanup();
    const concurrentCleanup = service.cleanup();

    expect(stopRunScriptSpy).toHaveBeenCalledTimes(1);

    finishStop();
    await Promise.all([firstCleanup, concurrentCleanup]);
    expect(mockCleanupTunnels).toHaveBeenCalledTimes(1);

    installExecution(service, 'ws-2', new FakeChildProcess(2));
    await service.cleanup();

    expect(stopRunScriptSpy).toHaveBeenCalledTimes(2);
    expect(mockCleanupTunnels).toHaveBeenCalledTimes(2);
  });

  it('registers shutdown handlers once and runs cleanup hooks', async () => {
    const { handlers, processOnSpy } = captureShutdownHandlers();

    const service = new RunScriptService();
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

    const secondService = new RunScriptService();
    const secondCleanupSyncSpy = vi
      .spyOn(secondService, 'cleanupSync')
      .mockImplementation(() => undefined);
    secondService.registerShutdownHandlers();
    (handlers.get('exit') as () => void)();

    expect(cleanupSyncSpy).toHaveBeenCalledTimes(0);
    expect(secondCleanupSyncSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to sync cleanup on SIGTERM failure and skips duplicate signals', async () => {
    const { handlers } = captureShutdownHandlers();
    const service = new RunScriptService();
    const cleanupSpy = vi.spyOn(service, 'cleanup').mockRejectedValue(new Error('cleanup failed'));
    const cleanupSyncSpy = vi.spyOn(service, 'cleanupSync').mockImplementation(() => undefined);
    service.registerShutdownHandlers();

    await (handlers.get('SIGTERM') as () => Promise<void>)();
    await (handlers.get('SIGTERM') as () => Promise<void>)();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSyncSpy).toHaveBeenCalledTimes(1);
  });
});
