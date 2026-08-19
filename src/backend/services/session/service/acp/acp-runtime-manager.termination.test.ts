import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AcpRuntimeManager,
  createManagerTestHarness,
  mockCancel,
  mockInitialize,
  mockLoggerWarn,
  mockSpawn,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  codexOptions,
  createDeferred,
  createMockChildProcess,
  createTestClient,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  exitChildAfterSigterm,
  exitChildWithCode,
  markChildKilledOnSignal,
  subagentBrowseCapabilities,
} from './acp-runtime-manager.test-helpers';

describe('AcpRuntimeManager', () => {
  let manager: AcpRuntimeManager;
  let harness: ReturnType<typeof createManagerTestHarness>;

  beforeEach(() => {
    harness = createManagerTestHarness();
    manager = harness.manager;
  });

  describe('stopClient', () => {
    it('deduplicates concurrent stops and creates a replacement after the original exits', async () => {
      const child = harness.setupSuccessfulSpawn();
      exitChildAfterSigterm(child);

      await createTestClient(manager);

      const firstStop = manager.stopClient('session-1');
      const duplicateStop = manager.stopClient('session-1');
      expect(duplicateStop).toBe(firstStop);
      await firstStop;
      harness.setupSuccessfulSpawn();
      await expect(createTestClient(manager)).resolves.toBeDefined();
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it('sends SIGTERM, waits grace period, cleans up references', async () => {
      const child = setupSuccessfulSpawn();

      await createTestClient(manager);

      // Make SIGTERM trigger exit
      exitChildWithCode(child);

      await manager.stopClient('session-1');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.getClient('session-1')).toBeUndefined();
    });

    it('clears the SIGTERM grace-period timeout when the child exits quickly', async () => {
      const child = setupSuccessfulSpawn();

      await createTestClient(manager);

      exitChildWithCode(child);

      vi.useFakeTimers();

      try {
        await manager.stopClient('session-1');

        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('escalates to SIGKILL after timeout', async () => {
      const child = setupSuccessfulSpawn();

      await createTestClient(manager);

      // SIGTERM does NOT cause exit - process stays alive
      const killCalls: string[] = [];
      child.kill = vi.fn((signal?: string) => {
        killCalls.push(signal ?? 'default');
        if (signal === 'SIGKILL') {
          child.killed = true;
          child.exitCode = 137;
          child.emit('exit', 137, 'SIGKILL');
        }
        return true;
      });

      vi.useFakeTimers();
      const stopPromise = manager.stopClient('session-1');

      // Advance past the 5s timeout
      await vi.advanceTimersByTimeAsync(5100);

      await stopPromise;

      expect(killCalls).toContain('SIGTERM');
      expect(killCalls).toContain('SIGKILL');
      expect(manager.getClient('session-1')).toBeUndefined();

      vi.useRealTimers();
    });

    it('cancels prompt if isPromptInFlight before SIGTERM', async () => {
      const child = setupSuccessfulSpawn();

      const handle = await createTestClient(manager);
      handle.isPromptInFlight = true;

      mockCancel.mockResolvedValue(undefined);

      // Make SIGTERM trigger exit
      exitChildWithCode(child);

      await manager.stopClient('session-1');

      expect(mockCancel).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
      });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('waits for an existing stop when called concurrently', async () => {
      const child = setupSuccessfulSpawn();

      await createTestClient(manager);

      child.kill = vi.fn(() => true);

      const firstStop = manager.stopClient('session-1');
      await vi.waitFor(() => {
        expect(manager.isStopInProgress('session-1')).toBe(true);
      });
      let secondStopSettled = false;
      const secondStop = manager.stopClient('session-1').then(() => {
        secondStopSettled = true;
      });
      await Promise.resolve();

      expect(secondStopSettled).toBe(false);

      child.exitCode = 0;
      child.emit('exit', 0, null);
      await Promise.all([firstStop, secondStop]);
      expect(secondStopSettled).toBe(true);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('quiesces a deferred post-creation reconciliation before stopping its runtime', async () => {
      // Catches allowing reconciliation to install a runtime after the final stop pass.
      const reconciliation = createDeferred<void>();
      const child = setupSuccessfulSpawn();
      exitChildAfterSigterm(child);
      const creation = manager.runClientCreationOperation('session-1', 'active', async () => {
        await reconciliation.promise;
        return createTestClient(manager);
      });

      const firstStop = manager.stopAndQuiesce('session-1');
      const secondStop = manager.stopAndQuiesce('session-1');
      expect(secondStop).toBe(firstStop);
      let stopSettled = false;
      void firstStop.then(() => {
        stopSettled = true;
      });
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      reconciliation.resolve(undefined);
      await creation;
      await Promise.all([firstStop, secondStop]);

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.getClient('session-1')).toBeUndefined();
    });

    it('runtime exit event atomically captures browse purpose for a managed stop', async () => {
      const child = setupSuccessfulSpawn({
        ...subagentBrowseCapabilities(),
        loadSession: true,
      });
      const onRuntimeExit = vi.fn().mockResolvedValue(undefined);
      const handlers = { ...defaultHandlers(), onRuntimeExit };

      await manager.getOrCreateClient(
        'session-1',
        {
          ...codexOptions(),
          purpose: 'browse',
          resumeProviderSessionId: 'provider-session-existing',
        },
        handlers,
        defaultContext()
      );

      exitChildWithCode(child);

      await manager.stopClient('session-1');

      expect(onRuntimeExit).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          exitCode: 0,
          purpose: 'browse',
          managed: true,
        })
      );
    });

    it('skips exit handler when a stopped process exits after stop timeout', async () => {
      const child = setupSuccessfulSpawn();
      const handlers = defaultHandlers();

      await manager.getOrCreateClient('session-1', defaultOptions(), handlers, defaultContext());

      markChildKilledOnSignal(child);

      vi.useFakeTimers();

      const stopPromise = manager.stopClient('session-1');
      await vi.advanceTimersByTimeAsync(5100);
      await stopPromise;

      vi.useRealTimers();

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(manager.isStopInProgress('session-1')).toBe(false);

      (handlers.onExit as ReturnType<typeof vi.fn>).mockClear();
      child.exitCode = 137;
      child.emit('exit', 137, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handlers.onExit).not.toHaveBeenCalled();
    });

    it('omits stale runtime error and exit events without affecting its replacement', async () => {
      const firstChild = setupSuccessfulSpawn();
      const firstHandlers = {
        ...defaultHandlers(),
        onRuntimeExit: vi.fn().mockResolvedValue(undefined),
        onRuntimeError: vi.fn(),
      };
      await createTestClient(manager, { handlers: firstHandlers });
      markChildKilledOnSignal(firstChild);

      vi.useFakeTimers();

      const stopPromise = manager.stopClient('session-1');
      await vi.advanceTimersByTimeAsync(5100);
      await stopPromise;
      vi.useRealTimers();
      const secondChild = createMockChildProcess();
      const secondHandlers = defaultHandlers();
      mockSpawn.mockReturnValueOnce(secondChild);
      const restartedHandle = await createTestClient(manager, { handlers: secondHandlers });

      firstChild.emit('error', new Error('stale provider transport failed'));
      firstChild.exitCode = 137;
      firstChild.emit('exit', 137, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(firstHandlers.onRuntimeError).not.toHaveBeenCalled();
      expect(firstHandlers.onRuntimeExit).not.toHaveBeenCalled();
      expect(manager.getClient('session-1')).toBe(restartedHandle);
    });

    it('rejects same-session reentrant exit creation and releases the fence', async () => {
      const child = setupSuccessfulSpawn();
      let exitHandlerSettled = false;
      const onRuntimeExit = vi.fn(async () => {
        try {
          await createTestClient(manager);
        } finally {
          exitHandlerSettled = true;
        }
      });
      await createTestClient(manager, { handlers: { ...defaultHandlers(), onRuntimeExit } });

      child.exitCode = 1;
      expect(() => child.emit('exit', 1, null)).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(exitHandlerSettled).toBe(true);
      expect(mockLoggerWarn).toHaveBeenCalledWith('Failed to handle ACP exit event', {
        sessionId: 'session-1',
        error: 'Cannot create ACP client for session session-1 from its runtime exit handler',
      });

      const replacementChild = setupSuccessfulSpawn();
      const replacementHandle = await createTestClient(manager);

      expect(manager.getClient('session-1')).toBe(replacementHandle);
      exitChildAfterSigterm(replacementChild);
      await manager.stopClient('session-1');
    });

    it('allows an exit handler to create a runtime for a different session', async () => {
      const firstChild = setupSuccessfulSpawn();
      let differentSessionCreated = false;
      const onRuntimeExit = vi.fn(async () => {
        await createTestClient(manager, { sessionId: 'session-2' });
        differentSessionCreated = true;
      });
      await createTestClient(manager, { handlers: { ...defaultHandlers(), onRuntimeExit } });
      const secondChild = setupSuccessfulSpawn();

      firstChild.emit('exit', 1, null);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(differentSessionCreated).toBe(true);
      expect(manager.getClient('session-2')).toBeDefined();
      exitChildAfterSigterm(secondChild);
      await manager.stopClient('session-2');
    });

    it('rejects client creation while a stop is in progress', async () => {
      const firstChild = setupSuccessfulSpawn();

      await createTestClient(manager);

      // SIGTERM marks the old process as no longer running, but delay exit.
      markChildKilledOnSignal(firstChild);

      const stopPromise = manager.stopClient('session-1');
      await vi.waitFor(() => {
        expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
      });

      await expect(createTestClient(manager)).rejects.toThrow('ACP session stop requested');
      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(firstChild.kill).toHaveBeenCalledOnce();

      firstChild.exitCode = 0;
      firstChild.emit('exit', 0, null);
      await stopPromise;

      expect(manager.getClient('session-1')).toBeUndefined();
    });

    it('rejects before spawning or dispatching child errors during stop', async () => {
      const firstChild = setupSuccessfulSpawn();

      await createTestClient(manager);

      // SIGTERM marks the old process as no longer running, but delay exit.
      markChildKilledOnSignal(firstChild);

      const stopPromise = manager.stopClient('session-1');
      await vi.waitFor(() => {
        expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
      });

      const onRuntimeError = vi.fn();
      const handlers = { ...defaultHandlers(), onRuntimeError };

      await expect(
        manager.getOrCreateClient('session-1', defaultOptions(), handlers, defaultContext())
      ).rejects.toThrow('ACP session stop requested');

      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(firstChild.kill).toHaveBeenCalledOnce();
      expect(onRuntimeError).not.toHaveBeenCalled();
      expect(handlers.onError).not.toHaveBeenCalled();

      firstChild.exitCode = 0;
      firstChild.emit('exit', 0, null);
      await stopPromise;
    });

    it('allows a replacement after stop rejects a concurrent create', async () => {
      const firstChild = setupSuccessfulSpawn();

      await createTestClient(manager);

      // SIGTERM marks process as no longer running but delays exit event.
      markChildKilledOnSignal(firstChild);

      const stopPromise = manager.stopClient('session-1');
      await vi.waitFor(() => {
        expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
      });

      const secondChild = createMockChildProcess();
      exitChildAfterSigterm(secondChild);
      mockSpawn.mockReturnValueOnce(secondChild);

      await expect(createTestClient(manager)).rejects.toThrow('ACP session stop requested');

      firstChild.exitCode = 0;
      firstChild.emit('exit', 0, null);

      await stopPromise;
      setupSuccessfulSpawn();
      await expect(createTestClient(manager)).resolves.toBeDefined();
    });
  });

  describe('stopAllClients', () => {
    it('waits for fence-only reconciliation while closing admission', async () => {
      const activeChild = setupSuccessfulSpawn();
      await createTestClient(manager, { sessionId: 'session-active' });
      const reconciliation = createDeferred<void>();
      const fenceOnly = manager.runClientCreationOperation(
        'session-fence-only',
        'browse',
        () => reconciliation.promise
      );
      expect(manager.hasClientCreationOperation('session-fence-only')).toBe(true);
      const shutdownSessionIds = manager.beginShutdown();
      expect(new Set(shutdownSessionIds)).toEqual(
        new Set(['session-active', 'session-fence-only'])
      );
      const lateOperation = vi.fn(() => Promise.resolve(undefined));
      await expect(
        manager.runClientCreationOperation('session-too-late', 'active', lateOperation)
      ).rejects.toThrow('ACP runtime manager is shutting down');
      expect(lateOperation).not.toHaveBeenCalled();
      exitChildWithCode(activeChild);
      const stopAll = manager.stopAllClients(50);
      let stopped = false;
      void stopAll.then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(stopped).toBe(false);
      reconciliation.resolve(undefined);
      await Promise.all([fenceOnly, stopAll]);
      expect(manager.hasClientCreationOperation('session-fence-only')).toBe(false);
    });

    it('clears per-client shutdown timeouts when clients stop quickly', async () => {
      const firstChild = setupSuccessfulSpawn();
      await createTestClient(manager);
      const secondChild = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(secondChild);

      await manager.getOrCreateClient(
        'session-2',
        { ...defaultOptions(), sessionId: 'session-2' },
        defaultHandlers(),
        defaultContext()
      );

      exitChildWithCode(firstChild);
      exitChildWithCode(secondChild);

      vi.useFakeTimers();

      try {
        await manager.stopAllClients(10_000);

        expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
        expect(secondChild.kill).toHaveBeenCalledWith('SIGTERM');
        expect(vi.getTimerCount()).toBe(0);
        expect([...manager.getAllClients()]).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects new client creation after shutdown begins', async () => {
      await manager.stopAllClients();

      await expect(
        createTestClient(manager, { sessionId: 'session-after-shutdown' })
      ).rejects.toThrow('ACP runtime manager is shutting down');

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('aborts in-flight client creation and cleans up the spawned subprocess', async () => {
      const child = createMockChildProcess();
      exitChildAfterSigterm(child);
      mockSpawn.mockReturnValue(child);
      mockInitialize.mockImplementation(
        () =>
          new Promise(() => {
            // Keep creation pending until shutdown aborts it.
          })
      );

      const createPromise = createTestClient(manager);
      const createRejection = createPromise.catch((error: unknown) => error);

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalledTimes(1);
      });

      await manager.stopAllClients(50);

      await expect(createRejection).resolves.toMatchObject({
        message: expect.stringContaining('ACP runtime manager is shutting down'),
      });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
      expect(manager.getClient('session-1')).toBeUndefined();
      expect(manager.getPendingClient('session-1')).toBeUndefined();
    });

    it('rejects queued creation requests after an in-flight creation is aborted', async () => {
      const child = createMockChildProcess();
      exitChildAfterSigterm(child);
      mockSpawn.mockReturnValue(child);
      mockInitialize.mockImplementation(
        () =>
          new Promise(() => {
            // Keep the first creation holding the per-session lock.
          })
      );

      const firstCreate = createTestClient(manager);
      const firstRejection = firstCreate.catch((error: unknown) => error);

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalledTimes(1);
      });

      const secondCreate = createTestClient(manager);
      const secondRejection = secondCreate.catch((error: unknown) => error);

      await manager.stopAllClients(50);

      await expect(firstRejection).resolves.toMatchObject({
        message: expect.stringContaining('ACP runtime manager is shutting down'),
      });
      await expect(secondRejection).resolves.toMatchObject({
        message: expect.stringContaining('ACP runtime manager is shutting down'),
      });
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(manager.getClient('session-1')).toBeUndefined();
    });
  });
});
