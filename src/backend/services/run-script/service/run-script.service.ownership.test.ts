import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunScriptStatus } from '@/shared/core';

const fakes = vi.hoisted(() => ({
  spawn: vi.fn(),
  kill: vi.fn(),
  port: vi.fn(),
  tunnel: vi.fn(),
  stopTunnel: vi.fn(),
  afterExitWrite: vi.fn(),
  afterStartWrite: vi.fn(),
  beforeStartWrite: vi.fn(),
  readWorkspace: vi.fn(),
  readCommands: vi.fn(),
  workspace: {
    id: 'ws-1',
    worktreePath: '/tmp/ws-1',
    runScriptCommand: 'pnpm dev --port {port}',
    runScriptPostRunCommand: null as string | null,
    runScriptCleanupCommand: null as string | null,
    runScriptStatus: 'IDLE' as RunScriptStatus,
    runScriptPid: null as number | null,
    runScriptPort: null as number | null,
    runScriptStartedAt: null as Date | null,
  },
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: fakes.spawn,
}));
vi.mock('tree-kill', () => ({ default: fakes.kill }));
vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: fakes.readWorkspace },
  workspaceRunScriptService: {
    findExecutionState: async () => ({ ...fakes.workspace }),
    getExecutionStateOrThrow: async () => ({ ...fakes.workspace }),
    transitionStatusIfCurrent: async (
      _id: string,
      status: RunScriptStatus,
      update: Partial<typeof fakes.workspace>
    ) => {
      if (update.runScriptStatus === 'STARTING') {
        await fakes.beforeStartWrite();
      }
      if (fakes.workspace.runScriptStatus !== status) {
        return { count: 0 };
      }
      Object.assign(fakes.workspace, update);
      if (update.runScriptStatus === 'STARTING') {
        await fakes.afterStartWrite();
      }
      if (update.runScriptStatus === 'COMPLETED') {
        await fakes.afterExitWrite();
      }
      return { count: 1 };
    },
  },
}));
vi.mock('./port-allocation.service', () => ({
  PortAllocationService: { findFreePort: fakes.port },
}));
vi.mock('./run-script-config-persistence.service', () => ({
  runScriptConfigPersistenceService: {
    reconcileWorkspaceCommandCache: fakes.readCommands,
  },
}));
vi.mock('./run-script-proxy.service', () => ({
  runScriptProxyService: {
    acquireTunnel: async (...args: unknown[]) => {
      const url = await fakes.tunnel(...args);
      return url ? { url, release: () => fakes.stopTunnel('ws-1') } : null;
    },
    stopTunnel: fakes.stopTunnel,
    getTunnelUrl: () => null,
    cleanup: async () => undefined,
    cleanupSync: () => undefined,
  },
}));
import { RunScriptService } from './run-script.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function child(pid: number) {
  const process = new ChildProcess();
  Object.defineProperty(process, 'pid', { value: pid });
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn(() => true);
  return process;
}
function exit(process: ChildProcess, code = 0) {
  Object.defineProperty(process, 'exitCode', { value: code, configurable: true });
  process.emit('exit', code, null);
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(fakes.workspace, {
    runScriptStatus: 'IDLE',
    runScriptPid: null,
    runScriptPort: null,
    runScriptStartedAt: null,
    runScriptPostRunCommand: null,
    runScriptCleanupCommand: null,
  });
  fakes.readWorkspace.mockImplementation(async () => ({ ...fakes.workspace }));
  fakes.readCommands.mockImplementation(async () => ({
    runScriptCommand: fakes.workspace.runScriptCommand,
    runScriptPostRunCommand: fakes.workspace.runScriptPostRunCommand,
    runScriptCleanupCommand: fakes.workspace.runScriptCleanupCommand,
  }));
  fakes.port.mockResolvedValue(4100);
  fakes.tunnel.mockResolvedValue(null);
  fakes.stopTunnel.mockResolvedValue(undefined);
  fakes.kill.mockImplementation((_pid, _signal, done) => done(null));
});

describe('run-script attempt ownership', () => {
  it('does not spawn after a stop completes during port allocation', async () => {
    const allocation = deferred<number>();
    const entered = deferred<void>();
    fakes.port.mockImplementation(() => {
      entered.resolve();
      return allocation.promise;
    });
    fakes.spawn.mockReturnValue(child(1001));
    const service = new RunScriptService();
    const start = service.startRunScript('ws-1');
    await entered.promise;
    expect(await service.stopRunScript('ws-1')).toEqual({ success: true });
    allocation.resolve(4100);
    expect((await start).success).toBe(false);
    expect(fakes.spawn.mock.calls.length).toBe(0);
    expect(fakes.workspace.runScriptStatus).toBe('IDLE');
  });

  it('keeps a replacement running when an older port allocation completes', async () => {
    const allocation = deferred<number>();
    const entered = deferred<void>();
    fakes.port.mockImplementationOnce(() => {
      entered.resolve();
      return allocation.promise;
    });
    fakes.spawn.mockReturnValue(child(2002));
    const service = new RunScriptService();
    const olderStart = service.startRunScript('ws-1');
    await entered.promise;
    await service.stopRunScript('ws-1');
    expect(await service.startRunScript('ws-1')).toMatchObject({ success: true, pid: 2002 });
    allocation.resolve(4101);
    expect((await olderStart).success).toBe(false);
    expect(fakes.spawn).toHaveBeenCalledTimes(1);
    expect(fakes.workspace.runScriptPid).toBe(2002);
    expect(fakes.workspace.runScriptStatus).toBe('RUNNING');
  });

  it('does not start postRun while the user cleanup command is still running', async () => {
    const tunnel = deferred<string | null>();
    const tunnelEntered = deferred<void>();
    const cleanupEntered = deferred<void>();
    const run = child(1001);
    const cleanup = child(1002);
    fakes.workspace.runScriptPostRunCommand = 'pnpm watch:assets';
    fakes.workspace.runScriptCleanupCommand = 'pnpm cleanup';
    fakes.tunnel.mockImplementation(() => {
      tunnelEntered.resolve();
      return tunnel.promise;
    });
    fakes.spawn.mockReturnValueOnce(run).mockImplementation(() => {
      cleanupEntered.resolve();
      return cleanup;
    });
    const service = new RunScriptService();
    const start = service.startRunScript('ws-1');
    await tunnelEntered.promise;
    const stop = service.stopRunScript('ws-1');
    await cleanupEntered.promise;
    tunnel.resolve('https://example.test');
    await start;
    // Startup has resumed, but the cleanup command has not completed.
    expect(fakes.spawn).toHaveBeenCalledTimes(2);
    exit(run);
    exit(cleanup);
    await stop;
    expect(fakes.workspace.runScriptStatus).toBe('IDLE');
  });

  it('settles an exit during user cleanup without failing the concurrent stop', async () => {
    const cleanupEntered = deferred<void>();
    const run = child(1001);
    const cleanup = child(1002);
    fakes.workspace.runScriptCleanupCommand = 'pnpm cleanup';
    fakes.spawn.mockReturnValueOnce(run).mockImplementationOnce(() => {
      cleanupEntered.resolve();
      return cleanup;
    });
    const service = new RunScriptService();
    await service.startRunScript('ws-1');
    const stop = service.stopRunScript('ws-1');
    await cleanupEntered.promise;
    exit(run);
    exit(cleanup);
    expect(await stop).toEqual({ success: true });
    expect(fakes.workspace.runScriptStatus).toBe('IDLE');
  });
  it('does not reconcile a replacement when the old stop finishes user cleanup', async () => {
    const cleanupEntered = deferred<void>();
    const run = child(1001);
    const cleanup = child(1002);
    const replacement = child(2002);
    fakes.workspace.runScriptCleanupCommand = 'pnpm cleanup';
    fakes.spawn
      .mockReturnValueOnce(run)
      .mockImplementationOnce(() => {
        cleanupEntered.resolve();
        return cleanup;
      })
      .mockReturnValueOnce(replacement);
    const service = new RunScriptService();
    await service.startRunScript('ws-1');
    const stop = service.stopRunScript('ws-1');
    await cleanupEntered.promise;
    exit(run);
    // The real status machine can publish IDLE before the cleanup command exits.
    await vi.waitFor(() => expect(fakes.workspace.runScriptStatus).toBe('IDLE'));
    expect(await service.startRunScript('ws-1')).toMatchObject({ success: true, pid: 2002 });
    exit(cleanup);
    expect(await stop).toEqual({ success: true });
    expect(fakes.workspace.runScriptStatus).toBe('RUNNING');
    expect(fakes.workspace.runScriptPid).toBe(2002);
  });

  it('releases the old execution tunnel after replacement during exit persistence', async () => {
    const committed = deferred<void>();
    const finishWrite = deferred<void>();
    const released = deferred<void>();
    const run = child(1001);
    const replacement = child(2002);
    fakes.spawn.mockReturnValueOnce(run).mockReturnValueOnce(replacement);
    fakes.tunnel.mockResolvedValue('https://example.test');
    fakes.afterExitWrite.mockImplementation(() => {
      committed.resolve();
      return finishWrite.promise;
    });
    fakes.stopTunnel.mockImplementation(() => {
      released.resolve();
      return Promise.resolve();
    });
    const service = new RunScriptService();
    await service.startRunScript('ws-1');
    exit(run);
    await committed.promise;
    expect(await service.startRunScript('ws-1')).toMatchObject({ success: true, pid: 2002 });
    finishWrite.resolve();
    await released.promise;
    expect(fakes.stopTunnel).toHaveBeenCalledTimes(1);
    expect(fakes.workspace.runScriptPid).toBe(2002);
  });
  it('keeps admission identity when stop and replacement finish before start returns', async () => {
    const committed = deferred<void>();
    const finishWrite = deferred<void>();
    fakes.afterStartWrite.mockImplementationOnce(() => {
      committed.resolve();
      return finishWrite.promise;
    });
    fakes.spawn.mockReturnValue(child(2002));
    const service = new RunScriptService();
    const olderStart = service.startRunScript('ws-1');
    await committed.promise;
    expect(fakes.workspace.runScriptStatus).toBe('STARTING');
    expect(await service.stopRunScript('ws-1')).toEqual({ success: true });
    expect(await service.startRunScript('ws-1')).toMatchObject({ success: true, pid: 2002 });
    finishWrite.resolve();
    expect((await olderStart).success).toBe(false);
    expect(fakes.spawn.mock.calls.length).toBe(1);
    expect(fakes.workspace.runScriptPid).toBe(2002);
  });
  it('reconciles a cancelled admission that commits after cleanup returns', async () => {
    const entered = deferred<void>();
    const proceed = deferred<void>();
    fakes.beforeStartWrite.mockImplementationOnce(() => {
      entered.resolve();
      return proceed.promise;
    });
    const service = new RunScriptService();
    const start = service.startRunScript('ws-1');
    await entered.promise;
    await service.cleanup();
    proceed.resolve();
    expect((await start).success).toBe(false);
    expect(fakes.spawn.mock.calls.length).toBe(0);
    expect(fakes.workspace.runScriptStatus).toBe('IDLE');
  });
  it.each(['workspace', 'configuration'] as const)(
    'revokes a start stopped during the %s read',
    async (phase) => {
      const entered = deferred<void>();
      const proceed = deferred<void>();
      const read = phase === 'workspace' ? fakes.readWorkspace : fakes.readCommands;
      read.mockImplementationOnce(async () => {
        entered.resolve();
        await proceed.promise;
        return { ...fakes.workspace };
      });
      fakes.spawn.mockReturnValue(child(1001));
      const service = new RunScriptService();
      const start = service.startRunScript('ws-1');
      await entered.promise;
      expect(await service.stopRunScript('ws-1')).toEqual({ success: true });
      proceed.resolve();
      expect((await start).success).toBe(false);
      expect(fakes.spawn.mock.calls.length).toBe(0);
      expect(fakes.workspace.runScriptStatus).toBe('IDLE');
    }
  );

  it.each(['workspace', 'configuration'] as const)(
    'revokes a start cleaned up during the %s read',
    async (phase) => {
      const entered = deferred<void>();
      const proceed = deferred<void>();
      const read = phase === 'workspace' ? fakes.readWorkspace : fakes.readCommands;
      read.mockImplementationOnce(async () => {
        entered.resolve();
        await proceed.promise;
        return { ...fakes.workspace };
      });
      fakes.spawn.mockReturnValue(child(1001));
      const service = new RunScriptService();
      const start = service.startRunScript('ws-1');
      await entered.promise;
      await service.cleanup();
      proceed.resolve();
      expect((await start).success).toBe(false);
      expect(fakes.spawn.mock.calls.length).toBe(0);
      expect(fakes.workspace.runScriptStatus).toBe('IDLE');
    }
  );

  it('refuses replacement admission while cleanup is awaiting its stop batch', async () => {
    const cleanupEntered = deferred<void>();
    const run = child(1001);
    const cleanup = child(1002);
    const replacement = child(2002);
    fakes.workspace.runScriptCleanupCommand = 'pnpm cleanup';
    fakes.spawn
      .mockReturnValueOnce(run)
      .mockImplementationOnce(() => {
        cleanupEntered.resolve();
        return cleanup;
      })
      .mockReturnValueOnce(replacement);
    const service = new RunScriptService();
    await service.startRunScript('ws-1');
    const allStopped = service.cleanup();
    await cleanupEntered.promise;
    exit(run);
    await vi.waitFor(() => expect(fakes.workspace.runScriptStatus).toBe('IDLE'));
    const replacementResult = await service.startRunScript('ws-1');
    exit(cleanup);
    await allStopped;
    expect(replacementResult.success).toBe(false);
    expect(fakes.spawn.mock.calls.length).toBe(2);
    expect(fakes.workspace.runScriptStatus).toBe('IDLE');
  });

  it('admits a fresh attempt again after an explicit cleanup finishes', async () => {
    const service = new RunScriptService();
    await service.cleanup();
    fakes.spawn.mockReturnValue(child(2002));
    expect(await service.startRunScript('ws-1')).toMatchObject({ success: true, pid: 2002 });
  });
});
