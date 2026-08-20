import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateAcpClientParams } from './acp-client-factory';
import type { AcpProcessHandle } from './acp-process-handle';
import {
  createDeferred,
  createTestProcessHandle,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  exitChildAfterSigterm,
  exitChildWithCode,
  type MockChildProcess,
  markChildKilledOnSignal,
} from './acp-runtime-manager.test-helpers';
import { AcpRuntimeSupervisor } from './acp-runtime-supervisor';

const loggerMocks = vi.hoisted(() => {
  const manager = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const other = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    manager,
    other,
    createLogger: vi.fn((category: string) =>
      category === 'acp-runtime-manager' ? manager : other
    ),
  };
});

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: loggerMocks.createLogger,
  getCurrentProcessEnv: () => ({}),
}));

type FactoryImplementation = (params: CreateAcpClientParams) => Promise<AcpProcessHandle>;
type CancelPrompt = (sessionId: string, handle: AcpProcessHandle) => Promise<boolean>;

function mockChildOf(handle: AcpProcessHandle): MockChildProcess {
  return handle.child as unknown as MockChildProcess;
}

function createHarness(implementation?: FactoryImplementation) {
  const createClient = vi.fn<FactoryImplementation>(
    implementation ?? (() => Promise.resolve(createTestProcessHandle()))
  );
  const cancelPrompt = vi.fn<CancelPrompt>(() => Promise.resolve(false));
  const supervisor = new AcpRuntimeSupervisor({
    clientFactory: { createClient },
    cancelPrompt,
  });
  return { supervisor, createClient, cancelPrompt };
}

async function install(
  supervisor: AcpRuntimeSupervisor,
  sessionId = 'session-1'
): Promise<AcpProcessHandle> {
  return await supervisor.getOrCreateClient(
    sessionId,
    { ...defaultOptions(), sessionId },
    defaultHandlers(),
    defaultContext()
  );
}

describe('AcpRuntimeSupervisor termination and shutdown ownership', () => {
  beforeEach(() => {
    vi.useRealTimers();
    loggerMocks.manager.debug.mockClear();
    loggerMocks.manager.info.mockClear();
    loggerMocks.manager.warn.mockClear();
    loggerMocks.manager.error.mockClear();
    loggerMocks.other.debug.mockClear();
    loggerMocks.other.info.mockClear();
    loggerMocks.other.warn.mockClear();
    loggerMocks.other.error.mockClear();
  });

  it('logs a deduplicated stop under the manager category', async () => {
    const handle = createTestProcessHandle();
    markChildKilledOnSignal(mockChildOf(handle));
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    await install(supervisor);

    const firstStop = supervisor.stopClient('session-1');
    await vi.waitFor(() => expect(handle.child.kill).toHaveBeenCalledWith('SIGTERM'));
    const duplicateStop = supervisor.stopClient('session-1');

    expect(duplicateStop).toBe(firstStop);
    expect(loggerMocks.manager.debug).toHaveBeenCalledWith('ACP session stop already in progress', {
      sessionId: 'session-1',
    });

    mockChildOf(handle).exitCode = 0;
    handle.child.emit('exit', 0, null);
    await firstStop;
  });

  it('returns the identical stop promise and admits a replacement after cleanup', async () => {
    // Catches duplicate signals or a settled stop operation retaining the session forever.
    const first = createTestProcessHandle();
    const replacement = createTestProcessHandle();
    exitChildWithCode(mockChildOf(first));
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const onRuntimeExit = vi.fn(() => Promise.resolve());
    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      { ...defaultHandlers(), onRuntimeExit },
      defaultContext()
    );

    const firstStop = supervisor.stopClient('session-1');
    const duplicateStop = supervisor.stopClient('session-1');
    expect(duplicateStop).toBe(firstStop);
    await firstStop;
    await expect(install(supervisor)).resolves.toBe(replacement);

    expect(first.child.kill).toHaveBeenCalledTimes(1);
    expect(first.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(createClient).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(onRuntimeExit).toHaveBeenCalledOnce());
    expect(onRuntimeExit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        managed: true,
        purpose: 'active',
        incarnationId: expect.any(String),
      })
    );
  });

  it('preserves a first-stop failure when no creation barrier exists', async () => {
    // Catches stopAndQuiesce swallowing the only attempted stop failure.
    const handle = createTestProcessHandle();
    mockChildOf(handle).kill = vi.fn(() => {
      throw new Error('signal failed');
    });
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    await install(supervisor);

    await expect(supervisor.stopAndQuiesce('session-1')).rejects.toThrow('signal failed');
    expect(supervisor.isStopInProgress('session-1')).toBe(false);
    expect(supervisor.getInstalledHandle('session-1')).toBe(handle);

    exitChildAfterSigterm(mockChildOf(handle));
    await supervisor.stopClient('session-1');
    expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();
  });

  it('retains the current handle when SIGTERM returns false and permits a retry', async () => {
    // Catches a failed signal unregistering a process that may still be alive.
    const handle = createTestProcessHandle();
    const child = mockChildOf(handle);
    let signalAttempt = 0;
    child.kill = vi.fn((signal?: string) => {
      signalAttempt += 1;
      if (signalAttempt === 1) {
        return false;
      }
      if (signal === 'SIGTERM') {
        queueMicrotask(() => {
          child.signalCode = 'SIGTERM';
          child.emit('exit', null, 'SIGTERM');
        });
      }
      return true;
    });
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    await install(supervisor);
    vi.useFakeTimers();

    try {
      const firstStop = supervisor.stopClient('session-1').then(
        () => undefined,
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(5001);
      await expect(firstStop).resolves.toMatchObject({
        message: 'Failed to send SIGTERM to ACP process for session session-1',
      });
      expect(supervisor.getInstalledHandle('session-1')).toBe(handle);

      await supervisor.stopClient('session-1');
      expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries the retained runtime after a first-stop failure when a creation barrier completes', async () => {
    // Catches a final stop pass targeting replacement work while the original process remains live.
    const first = createTestProcessHandle();
    const firstChild = mockChildOf(first);
    firstChild.kill = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('first signal failed');
      })
      .mockImplementation((signal?: string) => {
        if (signal === 'SIGTERM') {
          queueMicrotask(() => {
            firstChild.signalCode = 'SIGTERM';
            firstChild.emit('exit', null, 'SIGTERM');
          });
        }
        return true;
      });
    const barrier = createDeferred<void>();
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(first);
    await install(supervisor);
    const creation = supervisor.runClientCreationOperation('session-1', 'active', async () => {
      await barrier.promise;
      return await install(supervisor);
    });

    const stopping = supervisor.stopAndQuiesce('session-1');
    await vi.waitFor(() => expect(first.child.kill).toHaveBeenCalledWith('SIGTERM'));
    barrier.resolve(undefined);
    await expect(creation).resolves.toBe(first);
    await expect(stopping).resolves.toBeUndefined();

    expect(first.child.kill).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledOnce();
    expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();
  });

  it('makes a duplicate quiescing stop share identity while creation crosses an async boundary', async () => {
    // Catches a late factory result escaping both the initial stop and creation barrier.
    const handle = createTestProcessHandle();
    exitChildAfterSigterm(mockChildOf(handle));
    const factoryCreation = createDeferred<AcpProcessHandle>();
    const { supervisor } = createHarness(() => factoryCreation.promise);
    const creation = supervisor.runClientCreationOperation('session-1', 'active', () =>
      supervisor.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      )
    );
    await vi.waitFor(() => expect(supervisor.getPendingClient('session-1')).toBeDefined());

    const firstStop = supervisor.stopAndQuiesce('session-1');
    const secondStop = supervisor.stopAndQuiesce('session-1');
    expect(secondStop).toBe(firstStop);
    factoryCreation.resolve(handle);
    const [creationResult, stopResult] = await Promise.allSettled([creation, firstStop]);

    expect(creationResult).toMatchObject({ status: 'rejected' });
    expect(stopResult).toEqual({ status: 'fulfilled', value: undefined });
    expect(handle.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();
    expect(supervisor.getPendingClient('session-1')).toBeUndefined();
  });

  it('cancels an in-flight prompt before sending SIGTERM', async () => {
    // Catches signaling a child before protocol-level prompt cancellation is attempted.
    const handle = createTestProcessHandle();
    handle.isPromptInFlight = true;
    const order: string[] = [];
    exitChildWithCode(mockChildOf(handle));
    mockChildOf(handle).kill = vi.fn((signal?: string) => {
      order.push(signal ?? 'default');
      mockChildOf(handle).exitCode = 0;
      handle.child.emit('exit', 0, null);
      return true;
    });
    const { supervisor, cancelPrompt } = createHarness(() => Promise.resolve(handle));
    cancelPrompt.mockImplementation((sessionId, current) => {
      expect(sessionId).toBe('session-1');
      expect(current).toBe(handle);
      order.push('cancel');
      return Promise.resolve(true);
    });
    await install(supervisor);

    await supervisor.stopClient('session-1');

    expect(order).toEqual(['cancel', 'SIGTERM']);
  });

  it('escalates a live process from SIGTERM to SIGKILL after the grace period', async () => {
    // Catches a stuck provider preventing stop completion after ignoring SIGTERM.
    const handle = createTestProcessHandle();
    const child = mockChildOf(handle);
    const signals: string[] = [];
    child.kill = vi.fn((signal?: string) => {
      signals.push(signal ?? 'default');
      if (signal === 'SIGKILL') {
        child.exitCode = 137;
        child.emit('exit', 137, 'SIGKILL');
      }
      return true;
    });
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    await install(supervisor);
    vi.useFakeTimers();

    const stop = supervisor.stopClient('session-1');
    await vi.advanceTimersByTimeAsync(5001);
    await stop;

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a pending exit when SIGKILL reports that the process is already gone', async () => {
    // Catches a process exiting after the grace-period check but before SIGKILL is delivered.
    const handle = createTestProcessHandle();
    const child = mockChildOf(handle);
    const signals: string[] = [];
    child.kill = vi.fn((signal?: string) => {
      signals.push(signal ?? 'default');
      if (signal === 'SIGKILL') {
        queueMicrotask(() => {
          child.signalCode = 'SIGTERM';
          child.emit('exit', null, 'SIGTERM');
        });
        return false;
      }
      return true;
    });
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    await install(supervisor);
    vi.useFakeTimers();

    try {
      const stopResult = supervisor.stopClient('session-1').then(
        () => undefined,
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(5001);

      await expect(stopResult).resolves.toBeUndefined();
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the runtime when SIGKILL fails without a confirmed exit', async () => {
    // Catches a failed escalation unregistering a process whose termination remains unknown.
    const handle = createTestProcessHandle();
    const child = mockChildOf(handle);
    let retrying = false;
    child.kill = vi.fn((signal?: string) => {
      if (retrying && signal === 'SIGTERM') {
        queueMicrotask(() => {
          child.signalCode = 'SIGTERM';
          child.emit('exit', null, 'SIGTERM');
        });
        return true;
      }
      return signal !== 'SIGKILL';
    });
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    await install(supervisor);
    vi.useFakeTimers();

    try {
      const firstStop = supervisor.stopClient('session-1').then(
        () => undefined,
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(5001);
      await vi.advanceTimersByTimeAsync(5001);

      await expect(firstStop).resolves.toMatchObject({
        message: 'Failed to send SIGKILL to ACP process for session session-1',
      });
      expect(supervisor.getInstalledHandle('session-1')).toBe(handle);

      retrying = true;
      await supervisor.stopClient('session-1');
      expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not escalate after the process exits from SIGTERM with a null exit code', async () => {
    // Catches treating Node's signal-termination shape as a still-live child process.
    const handle = createTestProcessHandle();
    exitChildAfterSigterm(mockChildOf(handle));
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    await install(supervisor);

    await supervisor.stopClient('session-1');

    expect(handle.child.signalCode).toBe('SIGTERM');
    expect(handle.child.kill).toHaveBeenCalledOnce();
    expect(handle.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(handle.child.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('omits managed late exits and stale runtime events without deleting a replacement', async () => {
    // Catches a timed-out old process reporting or removing a newer incarnation.
    const first = createTestProcessHandle();
    markChildKilledOnSignal(mockChildOf(first));
    const replacement = createTestProcessHandle();
    const firstHandlers = {
      ...defaultHandlers(),
      onRuntimeExit: vi.fn(() => Promise.resolve()),
    };
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      firstHandlers,
      defaultContext()
    );
    vi.useFakeTimers();
    const stop = supervisor.stopClient('session-1');
    await vi.advanceTimersByTimeAsync(5001);
    await stop;
    vi.useRealTimers();
    await install(supervisor);

    mockChildOf(first).exitCode = 137;
    first.child.emit('exit', 137, 'SIGKILL');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(firstHandlers.onRuntimeExit).not.toHaveBeenCalled();
    expect(supervisor.getInstalledHandle('session-1')).toBe(replacement);
  });

  it('closes admission and inventories active, browse, pending, and barrier-only sessions', async () => {
    // Catches shutdown omitting non-active state sources or allowing late factory admission.
    const active = createTestProcessHandle();
    const browse = createTestProcessHandle();
    const pendingHandle = createTestProcessHandle();
    exitChildAfterSigterm(mockChildOf(active));
    exitChildAfterSigterm(mockChildOf(browse));
    exitChildAfterSigterm(mockChildOf(pendingHandle));
    const pending = createDeferred<AcpProcessHandle>();
    const barrier = createDeferred<void>();
    const { supervisor, createClient } = createHarness();
    createClient
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(browse)
      .mockReturnValueOnce(pending.promise);
    await install(supervisor, 'active-session');
    await supervisor.getOrCreateClient(
      'browse-session',
      { ...defaultOptions(), sessionId: 'browse-session', purpose: 'browse' },
      defaultHandlers(),
      defaultContext()
    );
    const pendingCreation = supervisor.getOrCreateClient(
      'pending-session',
      { ...defaultOptions(), sessionId: 'pending-session' },
      defaultHandlers(),
      defaultContext()
    );
    await vi.waitFor(() => expect(supervisor.getPendingClient('pending-session')).toBeDefined());
    const barrierOnly = supervisor.runClientCreationOperation(
      'barrier-session',
      'browse',
      () => barrier.promise
    );

    expect(new Set(supervisor.beginShutdown())).toEqual(
      new Set(['active-session', 'browse-session', 'pending-session', 'barrier-session'])
    );
    const lateOperation = vi.fn(() => Promise.resolve(undefined));
    await expect(
      supervisor.runClientCreationOperation('late-session', 'active', lateOperation)
    ).rejects.toThrow('ACP runtime manager is shutting down');
    await expect(install(supervisor, 'late-client')).rejects.toThrow(
      'ACP runtime manager is shutting down'
    );
    expect(lateOperation).not.toHaveBeenCalled();

    pending.resolve(pendingHandle);
    await expect(pendingCreation).rejects.toThrow('ACP runtime manager is shutting down');
    barrier.resolve(undefined);
    await barrierOnly;
    expect(pendingHandle.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('returns after the pending-creation timeout and clears creation registries', async () => {
    // Catches shutdown hanging forever on an uncooperative factory promise.
    const never = new Promise<AcpProcessHandle>(() => undefined);
    const { supervisor } = createHarness(() => never);
    void supervisor.getOrCreateClient(
      'pending-session',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    await vi.waitFor(() => expect(supervisor.getPendingClient('pending-session')).toBeDefined());
    vi.useFakeTimers();

    const stopping = supervisor.stopAllClients(50);
    await vi.advanceTimersByTimeAsync(51);
    await stopping;

    expect(supervisor.getPendingClient('pending-session')).toBeUndefined();
    expect(supervisor.isBrowseOnlySession('pending-session')).toBe(false);
    expect(supervisor.beginShutdown()).toEqual([]);
    expect([...supervisor.getAllClients()]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for quiescence and performs a final stop sweep before clearing registries', async () => {
    // Catches shutdown returning before admitted reconciliation finishes and its runtime is stopped.
    const first = createTestProcessHandle();
    const late = createTestProcessHandle();
    exitChildAfterSigterm(mockChildOf(first));
    exitChildAfterSigterm(mockChildOf(late));
    const reconciliation = createDeferred<void>();
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(first).mockResolvedValueOnce(late);
    await install(supervisor, 'session-1');
    const operation = supervisor.runClientCreationOperation('late-session', 'active', async () => {
      await reconciliation.promise;
      return await install(supervisor, 'late-session');
    });
    const operationResult = operation.catch((error: unknown) => error);

    const stopping = supervisor.stopAllClients(50);
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    reconciliation.resolve(undefined);
    await stopping;
    await expect(operationResult).resolves.toMatchObject({
      message: expect.stringContaining('ACP runtime manager is shutting down'),
    });

    expect(first.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(late.child.kill).not.toHaveBeenCalled();
    expect(supervisor.hasClientCreationOperation('late-session')).toBe(false);
    expect(supervisor.getPendingClient('late-session')).toBeUndefined();
    expect(supervisor.beginShutdown()).toEqual([]);
    expect([...supervisor.getAllClients()]).toEqual([]);
  });

  it('finishes shutdown cleanup and the final sweep before rethrowing a stop failure', async () => {
    // Catches one kill failure short-circuiting quiescence, the final sweep, and registry cleanup.
    const failing = createTestProcessHandle();
    mockChildOf(failing).kill = vi.fn(() => {
      throw new Error('signal failed');
    });
    const slow = createTestProcessHandle();
    markChildKilledOnSignal(mockChildOf(slow));
    const barrier = createDeferred<void>();
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(failing).mockResolvedValueOnce(slow);
    await install(supervisor, 'failing-session');
    await install(supervisor, 'slow-session');
    const barrierOperation = supervisor.runClientCreationOperation(
      'barrier-session',
      'browse',
      () => barrier.promise
    );
    vi.useFakeTimers();

    let shutdownSettled = false;
    const shutdownResult = supervisor.stopAllClients(20).then(
      () => undefined,
      (error: unknown) => error
    );
    void shutdownResult.then(() => {
      shutdownSettled = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    const settledAfterFirstPass = shutdownSettled;
    barrier.resolve(undefined);
    await barrierOperation;
    await vi.advanceTimersByTimeAsync(20);
    const shutdownError = await shutdownResult;
    const remainingClients = [...supervisor.getAllClients()];
    const remainingInventory = supervisor.beginShutdown();
    const barrierStillTracked = supervisor.hasClientCreationOperation('barrier-session');

    await vi.advanceTimersByTimeAsync(5001);

    expect(settledAfterFirstPass).toBe(false);
    expect(shutdownError).toMatchObject({ message: 'signal failed' });
    expect(remainingClients).toEqual([]);
    expect(remainingInventory).toEqual([]);
    expect(barrierStillTracked).toBe(false);
    expect(slow.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('uses the final sweep to wait for a stop that outlives the first shutdown pass', async () => {
    // Catches clearing a still-running registry immediately after the first soft stop timeout.
    const handle = createTestProcessHandle();
    markChildKilledOnSignal(mockChildOf(handle));
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    await install(supervisor);
    vi.useFakeTimers();

    let settled = false;
    const stopping = supervisor.stopAllClients(50).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);

    mockChildOf(handle).exitCode = 0;
    handle.child.emit('exit', 0, null);
    await stopping;

    expect(handle.child.kill).toHaveBeenCalledOnce();
    expect(handle.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect([...supervisor.getAllClients()]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops active and browse clients and leaves no observable registry state', async () => {
    // Catches final cleanup clearing only the public active-client view.
    const active = createTestProcessHandle();
    const browse = createTestProcessHandle();
    exitChildWithCode(mockChildOf(active));
    exitChildWithCode(mockChildOf(browse));
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(active).mockResolvedValueOnce(browse);
    await install(supervisor, 'active-session');
    await supervisor.getOrCreateClient(
      'browse-session',
      { ...defaultOptions(), sessionId: 'browse-session', purpose: 'browse' },
      defaultHandlers(),
      defaultContext()
    );

    await supervisor.stopAllClients(500);

    expect(active.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(browse.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.getInstalledHandle('active-session')).toBeUndefined();
    expect(supervisor.getInstalledHandle('browse-session')).toBeUndefined();
    expect(supervisor.isBrowseOnlySession('browse-session')).toBe(false);
    expect(supervisor.isStopInProgress('active-session')).toBe(false);
    expect(supervisor.isStopInProgress('browse-session')).toBe(false);
    expect(supervisor.getAllActiveProcesses()).toEqual([]);
    expect(supervisor.beginShutdown()).toEqual([]);
  });
});
