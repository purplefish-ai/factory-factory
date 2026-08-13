import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionLifecycleService } from './session.lifecycle.service';
import { createDeferred, createLifecycleHarness } from './session-lifecycle.test-helpers';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ NODE_ENV: 'test' }),
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(),
    markDelivered: vi.fn(),
  },
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
    get: vi.fn(async () => ({
      defaultWorkspacePermissions: 'STRICT',
      ratchetPermissions: 'YOLO',
    })),
  },
}));

describe('SessionTerminationCoordinator workspace stops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops running sessions and runtime-only sessions', async () => {
    const { service, repository, runtimeManager } = createLifecycleHarness();
    const stopSession = vi.spyOn(service, 'stopSession').mockResolvedValue();

    await service.stopWorkspaceSessions('workspace-1');

    expect(repository.getSessionsByWorkspaceId).toHaveBeenCalledWith('workspace-1');
    expect(runtimeManager.isSessionRunning).toHaveBeenCalledWith('session-runtime-only');
    expect(runtimeManager.isSessionRunning).toHaveBeenCalledWith('session-idle');
    expect(stopSession).toHaveBeenCalledWith('session-running', { reason: 'SYSTEM_STOP' });
    expect(stopSession).toHaveBeenCalledWith('session-runtime-only', { reason: 'SYSTEM_STOP' });
    expect(stopSession).toHaveBeenCalledWith('session-browse-only', {
      reason: 'SYSTEM_STOP',
      recordLifecycleEvent: false,
    });
    expect(stopSession).not.toHaveBeenCalledWith('session-idle');
  });

  it('attempts every running session and throws when any stop fails', async () => {
    const { service } = createLifecycleHarness();
    const stopSession = vi.spyOn(service, 'stopSession').mockResolvedValue();
    stopSession.mockImplementation((sessionId: string) => {
      if (sessionId === 'session-running') {
        return Promise.reject(new Error('stop failed'));
      }
      return Promise.resolve();
    });

    await expect(service.stopWorkspaceSessions('workspace-1')).rejects.toThrow(
      'Failed to stop 1 workspace session'
    );
    expect(stopSession).toHaveBeenCalledWith('session-running', { reason: 'SYSTEM_STOP' });
    expect(stopSession).toHaveBeenCalledWith('session-runtime-only', { reason: 'SYSTEM_STOP' });
  });
});

describe('SessionTerminationCoordinator stop causes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['USER_STOP', 'Session stopped by you.'],
    ['SESSION_CLOSED', 'Session closed by you.'],
    ['WORKSPACE_ARCHIVED', 'Session stopped because the workspace was archived.'],
    ['SYSTEM_STOP', 'Session stopped by the system.'],
  ] as const)('records %s before stopping the runtime', async (reason, message) => {
    const { service, lifecycleEventService, runtimeManager } = createLifecycleHarness();

    await service.stopSession('session-1', { reason });

    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        kind: 'SESSION_STOPPED',
        reason,
        message,
        dedupeKey: expect.stringMatching(
          /^session-stop:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
      })
    );
    expect(lifecycleEventService.record.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeManager.stopClient.mock.invocationCallOrder[0]!
    );
  });

  it('uses a new durable stop identity after lifecycle-service reconstruction', async () => {
    const first = createLifecycleHarness();
    const reconstructed = createLifecycleHarness();

    await first.service.stopSession('session-1', { reason: 'USER_STOP' });
    await reconstructed.service.stopSession('session-1', { reason: 'USER_STOP' });

    const firstKey = first.lifecycleEventService.record.mock.calls[0]?.[0]?.dedupeKey;
    const reconstructedKey =
      reconstructed.lifecycleEventService.record.mock.calls[0]?.[0]?.dedupeKey;
    expect(firstKey).toMatch(/^session-stop:/);
    expect(reconstructedKey).toMatch(/^session-stop:/);
    expect(reconstructedKey).not.toBe(firstKey);
  });

  it('can clean up a failed startup without recording a stop event', async () => {
    const { service, lifecycleEventService, runtimeManager } = createLifecycleHarness();

    await service.stopSession('session-1', { recordLifecycleEvent: false });

    expect(lifecycleEventService.record).not.toHaveBeenCalled();
    expect(runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
  });
});

describe('SessionTerminationCoordinator graceful shutdown', () => {
  it('records SYSTEM_STOP for active and pending runtimes before bounded shutdown', async () => {
    const runtimeManager = {
      beginShutdown: vi.fn(() => ['session-active', 'session-pending', 'session-browse-only']),
      stopAllClients: vi.fn(async () => undefined),
      isStopInProgress: vi.fn(() => false),
      isBrowseOnlySession: vi.fn((sessionId: string) => sessionId === 'session-browse-only'),
    };
    const repository = {
      getSessionById: vi.fn(async (sessionId: string) => ({
        id: sessionId,
        workspaceId: 'workspace-1',
        workflow: 'code',
      })),
    };
    const lifecycleEventService = {
      record: vi.fn(async () => null),
      hydrate: vi.fn(async () => undefined),
    };
    const promptTurnCompletionService = {
      clearAll: vi.fn(),
    };
    const service = new SessionLifecycleService(
      unsafeCoerce({
        repository,
        promptBuilder: {},
        runtimeManager,
        sessionDomainService: {},
        sessionPermissionService: {},
        sessionConfigService: {},
        acpEventProcessor: { getWorkspaceId: vi.fn() },
        promptTurnCompletionService,
        retryService: {
          run: vi.fn(async (operation: () => Promise<unknown>) => await operation()),
        },
        lifecycleEventService,
        hydrateProviderHistory: vi.fn(),
        sendSessionMessage: vi.fn(),
      })
    );

    await service.stopAllClients(4321);

    expect(runtimeManager.beginShutdown).toHaveBeenCalledOnce();
    expect(lifecycleEventService.record).toHaveBeenCalledTimes(2);
    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-active',
        reason: 'SYSTEM_STOP',
      })
    );
    expect(lifecycleEventService.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-browse-only' })
    );
    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-pending',
        reason: 'SYSTEM_STOP',
      })
    );
    expect(runtimeManager.beginShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycleEventService.record.mock.invocationCallOrder[0]!
    );
    expect(lifecycleEventService.record.mock.invocationCallOrder.at(-1)).toBeLessThan(
      runtimeManager.stopAllClients.mock.invocationCallOrder[0]!
    );
    expect(runtimeManager.stopAllClients).toHaveBeenCalledWith(4321);
  });

  it('continues runtime shutdown after lifecycle recording timeout', async () => {
    vi.useFakeTimers();
    try {
      const runtimeManager = {
        beginShutdown: vi.fn(() => ['session-active']),
        stopAllClients: vi.fn(async () => undefined),
        isStopInProgress: vi.fn(() => false),
        isBrowseOnlySession: vi.fn(() => false),
      };
      const service = new SessionLifecycleService(
        unsafeCoerce({
          repository: {
            getSessionById: vi.fn(async () => ({
              id: 'session-active',
              workspaceId: 'workspace-1',
              workflow: 'code',
            })),
          },
          promptBuilder: {},
          runtimeManager,
          sessionDomainService: {},
          sessionPermissionService: {},
          sessionConfigService: {},
          acpEventProcessor: { getWorkspaceId: vi.fn() },
          promptTurnCompletionService: { clearAll: vi.fn() },
          retryService: {
            run: vi.fn(async (operation: () => Promise<unknown>) => await operation()),
          },
          lifecycleEventService: {
            record: vi.fn(() => new Promise(() => undefined)),
            hydrate: vi.fn(async () => undefined),
          },
          hydrateProviderHistory: vi.fn(),
          sendSessionMessage: vi.fn(),
        })
      );

      const shutdown = service.stopAllClients(4321);
      await vi.advanceTimersByTimeAsync(999);
      expect(runtimeManager.stopAllClients).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await shutdown;

      expect(runtimeManager.stopAllClients).toHaveBeenCalledWith(4321);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionTerminationCoordinator races', () => {
  it('releases the stop generation after a session stops', async () => {
    const { service } = createLifecycleHarness();
    const stopGeneration = service.getStopGeneration('session-1');

    await service.stopSession('session-1');

    expect(service.getStopGeneration('session-1')).not.toBe(stopGeneration);
  });

  it('releases the stop generation when viewers retain inactive session state', async () => {
    const { service, sessionDomainService } = createLifecycleHarness();
    const stopGeneration = service.getStopGeneration('session-1');
    sessionEventBus.registerViewerCountProvider((sessionId) => (sessionId === 'session-1' ? 1 : 0));

    try {
      await service.stopSession('session-1');
    } finally {
      sessionEventBus.registerViewerCountProvider(null);
    }

    expect(sessionDomainService.clearSession).not.toHaveBeenCalled();
    expect(service.getStopGeneration('session-1')).not.toBe(stopGeneration);
  });

  it('waits for a registered client creation and stops the resulting runtime', async () => {
    const { service, sendSessionMessage, runtimeManager } = createLifecycleHarness();
    type RuntimeHandle = Awaited<ReturnType<typeof runtimeManager.getOrCreateClient>>;
    let resolveClient!: (handle: RuntimeHandle) => void;
    const pendingClient = new Promise<RuntimeHandle>((resolve) => {
      resolveClient = resolve;
    });
    runtimeManager.getOrCreateClient.mockReturnValueOnce(pendingClient);

    const startResult = service.startSession('session-1').catch((error) => error);
    await vi.waitFor(() => {
      expect(runtimeManager.getOrCreateClient).toHaveBeenCalled();
    });

    const stopPromise = service.stopSession('session-1');
    await vi.waitFor(() => {
      expect(runtimeManager.stopClient).toHaveBeenCalledTimes(1);
    });
    resolveClient(
      unsafeCoerce<RuntimeHandle>({
        provider: 'CLAUDE',
        providerSessionId: 'provider-session-1',
        configOptions: [],
        isPromptInFlight: false,
      })
    );

    await stopPromise;
    await expect(startResult).resolves.toEqual(
      expect.objectContaining({ message: 'Session is currently being stopped' })
    );
    expect(runtimeManager.stopClient).toHaveBeenCalledTimes(2);
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('returns a duplicate stop early while preserving the active stop barrier', async () => {
    const harness = createLifecycleHarness();
    const stopEvent = createDeferred<null>();
    harness.lifecycleEventService.record.mockReturnValueOnce(stopEvent.promise);

    const firstStop = harness.service.stopSession('session-1');
    await vi.waitFor(() => {
      expect(harness.lifecycleEventService.record).toHaveBeenCalledTimes(1);
    });

    await expect(harness.service.stopSession('session-1')).resolves.toBeUndefined();
    expect(harness.service.isSessionStopping('session-1')).toBe(true);
    await expect(harness.service.getOrCreateSessionClient('session-1')).rejects.toThrow(
      'Session is currently being stopped'
    );
    expect(harness.lifecycleEventService.record).toHaveBeenCalledTimes(1);
    expect(harness.runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
    expect(harness.runtimeManager.stopClient).not.toHaveBeenCalled();
    expect(harness.sessionDomainService.clearQueuedWork).toHaveBeenCalledTimes(1);

    stopEvent.resolve(null);
    await firstStop;

    expect(harness.service.isSessionStopping('session-1')).toBe(false);
    expect(harness.runtimeManager.stopClient).toHaveBeenCalledTimes(1);
    expect(harness.repository.updateSessionIfStatus).toHaveBeenCalledTimes(1);
    expect(harness.sessionDomainService.clearSession).toHaveBeenCalledTimes(1);
  });
});
