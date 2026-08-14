import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpBrowseSessionUnavailableError } from '@/backend/services/session/service/acp/acp-runtime-manager';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { workspaceNotificationService } from '@/backend/services/workspace';
import { SessionStatus } from '@/shared/core';
import { SessionService } from './session.service';
import {
  createDeferred,
  createLifecycleHarness,
  createPendingWorkspaceNotification,
  type LifecycleHarness,
} from './session-lifecycle.test-helpers';
import {
  SessionStartupCoordinator,
  type SessionStartupCoordinatorDependencies,
} from './session-startup.coordinator';

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

function createStartupCoordinator(harness: LifecycleHarness): SessionStartupCoordinator {
  const dependencies = {
    repository: harness.repository,
    contextService: harness.contextService,
    acpEnvironment: harness.acpEnvironment,
    runtimeManager: harness.runtimeManager,
    sessionDomainService: harness.sessionDomainService,
    sessionConfigService: harness.sessionConfigService,
    acpEventProcessor: harness.acpEventProcessor,
    runtimeExitCoordinator: { createHandlers: vi.fn(() => ({})) },
    lifecycleGate: harness.lifecycleGate,
    notificationDelivery: harness.notificationDeliveryService,
    getMessageQueueBridge: () => harness.messageQueueBridge,
    sendSessionMessage: harness.sendSessionMessage,
    stopSession: (sessionId, options) => harness.service.stopSession(sessionId, options),
    registerClientCreation: () => ({
      isOnlyOperation: () => true,
      release: vi.fn(),
    }),
  } satisfies SessionStartupCoordinatorDependencies;
  return new SessionStartupCoordinator(dependencies);
}

describe('SessionStartupCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([]);
    vi.mocked(workspaceNotificationService.markDelivered).mockResolvedValue();
  });

  it('reconciles a newly created client to durable and in-memory running state', async () => {
    const harness = createLifecycleHarness();
    const coordinator = createStartupCoordinator(harness);

    await expect(coordinator.getOrCreateSessionClient('session-1')).resolves.toBe(harness.handle);

    expect(harness.repository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.RUNNING,
    });
    expect(harness.sessionDomainService.setRuntimeSnapshot).toHaveBeenLastCalledWith('session-1', {
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: expect.any(String),
    });
  });

  it('preserves the running-before-stopping restart probe order', async () => {
    const harness = createLifecycleHarness();
    const probes: string[] = [];
    harness.runtimeManager.isSessionRunning.mockImplementationOnce(() => {
      probes.push('running');
      return true;
    });
    harness.runtimeManager.isStopInProgress.mockImplementationOnce(() => {
      probes.push('stopping');
      return true;
    });
    const coordinator = createStartupCoordinator(harness);

    await expect(coordinator.restartSession('session-1')).rejects.toThrow(
      'Cannot restart: session is currently being stopped. Please try again shortly.'
    );

    expect(probes).toEqual(['running', 'stopping']);
  });

  it('builds ACP startup options through the injected environment port', async () => {
    const { service, runtimeManager, acpEnvironment } = createLifecycleHarness({
      workspace: { parentWorkspaceId: 'parent-workspace' },
    });
    const mcpServers = [
      {
        name: 'child-workspace-tools',
        command: 'child-workspace-server',
        args: ['--stdio'],
        env: { FF_WORKSPACE_ID: 'workspace-1' },
      },
    ];
    acpEnvironment.getMcpServers.mockReturnValueOnce(mcpServers);

    await service.getOrCreateSessionClient('session-1');

    expect(acpEnvironment.getMcpServers).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      parentWorkspaceId: 'parent-workspace',
    });
    expect(runtimeManager.getOrCreateClient).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ mcpServers }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('restores a stopped Codex session for browsing without activating it', async () => {
    const { service, repository, runtimeManager, handle, sessionDomainService } =
      createLifecycleHarness({
        provider: 'CODEX',
        providerSessionId: 'provider-session-existing',
      });
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      createPendingWorkspaceNotification(),
    ] as never);
    runtimeManager.getOrCreateClient.mockImplementationOnce((_id, options) => {
      expect(options).toMatchObject({
        purpose: 'browse',
        resumeProviderSessionId: 'provider-session-existing',
      });
      runtimeManager.getSubagentBrowseCapability.mockReturnValue({
        version: 1,
        list: true,
        read: true,
        notifications: true,
      });
      return Promise.resolve(handle);
    });

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(true);

    expect(repository.markWorkspaceHasHadSessions).not.toHaveBeenCalled();
    expect(repository.updateSession).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ status: SessionStatus.RUNNING })
    );
    expect(workspaceNotificationService.listPendingForDelivery).not.toHaveBeenCalled();
    expect(sessionDomainService.setRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it('does not spawn a browse client without a stored provider session', async () => {
    const { service, runtimeManager } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: null,
    });

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(false);

    expect(runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
  });

  it('cleans a failed initial startup after an unsupported browse probe', async () => {
    const { service, runtimeManager } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: null,
    });
    const generationBeforeBrowse = service.getStopGeneration('session-1');

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(false);
    runtimeManager.getOrCreateClient.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(service.startSession('session-1')).rejects.toThrow('spawn failed');

    const sentinelGeneration = service.getStopGeneration('sentinel-session');
    const generationAfterFailure = service.getStopGeneration('session-1');
    expect(sentinelGeneration).toBeGreaterThan(generationBeforeBrowse);
    expect(generationAfterFailure).toBeGreaterThan(sentinelGeneration);
  });

  it('returns unsupported when the stopped session has no usable worktree', async () => {
    const { service, runtimeManager } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
      worktreePath: null,
    });

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(false);

    expect(runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
  });

  it('returns unsupported when the provider cannot restore the stored session', async () => {
    const { service, runtimeManager } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
    });
    runtimeManager.getOrCreateClient.mockRejectedValueOnce(
      new AcpBrowseSessionUnavailableError('loadSession unsupported')
    );

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(false);
  });

  it('stops a browse-only client when the provider lacks sub-agent browsing', async () => {
    const { service, runtimeManager, acpEventProcessor } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
    });
    runtimeManager.isBrowseOnlySession.mockReturnValue(true);

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(false);

    expect(runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
    expect(acpEventProcessor.clearSessionState).toHaveBeenCalledWith('session-1');
  });

  it('cancels an active startup that began before unsupported browse cleanup', async () => {
    const { service, session, repository, runtimeManager } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
    });
    const activeSessionLookup = createDeferred<typeof session>();
    const browseStop = createDeferred<undefined>();
    repository.getSessionById.mockReturnValueOnce(activeSessionLookup.promise);
    runtimeManager.isBrowseOnlySession.mockReturnValue(true);
    runtimeManager.stopClient.mockReturnValueOnce(browseStop.promise);

    const activeStartup = service.getOrCreateSessionClient('session-1');
    await vi.waitFor(() => {
      expect(repository.getSessionById).toHaveBeenCalledTimes(1);
    });

    const browseResult = service.ensureSubagentBrowseSession('session-1');
    await vi.waitFor(() => {
      expect(runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
    });

    activeSessionLookup.resolve(session);
    await expect(activeStartup).rejects.toThrow();

    browseStop.resolve(undefined);
    await expect(browseResult).resolves.toBe(false);
    expect(runtimeManager.getOrCreateClient).toHaveBeenCalledTimes(1);
  });

  it('returns unsupported when concurrent browse cleanup invalidates its startup', async () => {
    const { service, session, repository, runtimeManager } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
    });
    const firstSessionLookup = createDeferred<typeof session>();
    const secondSessionLookup = createDeferred<typeof session>();
    const browseStop = createDeferred<undefined>();
    repository.getSessionById
      .mockReturnValueOnce(firstSessionLookup.promise)
      .mockReturnValueOnce(secondSessionLookup.promise);
    runtimeManager.isBrowseOnlySession.mockReturnValue(true);
    runtimeManager.stopClient.mockReturnValueOnce(browseStop.promise);

    const firstBrowse = service.ensureSubagentBrowseSession('session-1');
    const secondBrowse = service.ensureSubagentBrowseSession('session-1');
    await vi.waitFor(() => {
      expect(repository.getSessionById).toHaveBeenCalledTimes(2);
    });

    firstSessionLookup.resolve(session);
    await vi.waitFor(() => {
      expect(runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
    });

    secondSessionLookup.resolve(session);
    await expect(secondBrowse).resolves.toBe(false);

    browseStop.resolve(undefined);
    await expect(firstBrowse).resolves.toBe(false);
    expect(runtimeManager.getOrCreateClient).toHaveBeenCalledTimes(1);
  });

  it('does not let a failed browse creation clear a concurrent active startup context', async () => {
    const { service, handle, runtimeManager, acpEventProcessor } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
    });
    const browseCreation = createDeferred<typeof handle>();
    const activeCreation = createDeferred<typeof handle>();
    runtimeManager.getOrCreateClient
      .mockReturnValueOnce(browseCreation.promise)
      .mockReturnValueOnce(activeCreation.promise);

    const browseResult = service
      .ensureSubagentBrowseSession('session-1')
      .catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(runtimeManager.getOrCreateClient).toHaveBeenCalledTimes(1);
    });
    const activeResult = service.getOrCreateSessionClient('session-1');
    await vi.waitFor(() => {
      expect(runtimeManager.getOrCreateClient).toHaveBeenCalledTimes(2);
    });

    browseCreation.reject(new Error('browse restore failed'));
    await expect(browseResult).resolves.toEqual(
      expect.objectContaining({ message: 'browse restore failed' })
    );
    expect(acpEventProcessor.clearSessionState).not.toHaveBeenCalled();

    activeCreation.resolve(handle);
    await expect(activeResult).resolves.toBe(handle);
  });

  it('omits provider-session persistence from browse-only runtime handlers', async () => {
    const { service, runtimeManager } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
    });

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(false);

    const handlers = runtimeManager.getOrCreateClient.mock.calls[0]?.[2];

    expect(handlers).toBeDefined();
    expect(handlers?.onSessionId).toBeUndefined();
  });

  it('promotes a restored browse client through the normal active startup path', async () => {
    const {
      service,
      repository,
      runtimeManager,
      handle,
      sessionDomainService,
      sessionConfigService,
    } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
    });
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      createPendingWorkspaceNotification(),
    ] as never);
    runtimeManager.getOrCreateClient.mockImplementation((_id, options) => {
      if (options.purpose === 'browse') {
        runtimeManager.getSubagentBrowseCapability.mockReturnValue({
          version: 1,
          list: true,
          read: true,
          notifications: true,
        });
      }
      return Promise.resolve(handle);
    });

    await service.ensureSubagentBrowseSession('session-1');
    await expect(service.getOrCreateSessionClient('session-1')).resolves.toBe(handle);

    expect(runtimeManager.getOrCreateClient).toHaveBeenCalledTimes(2);
    expect(runtimeManager.getOrCreateClient.mock.calls[0]?.[1]).toMatchObject({
      purpose: 'browse',
    });
    expect(runtimeManager.getOrCreateClient.mock.calls[1]?.[1].purpose).toBeUndefined();
    expect(repository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.RUNNING,
    });
    expect(sessionConfigService.applyConfiguredPermissionPreset).toHaveBeenCalledTimes(1);
    expect(workspaceNotificationService.listPendingForDelivery).toHaveBeenCalledTimes(1);
    expect(sessionDomainService.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not retain a stop generation for a missing session', async () => {
    const { service, repository } = createLifecycleHarness();
    repository.getSessionById.mockResolvedValueOnce(null);
    const generationBeforeFailure = service.getStopGeneration('missing-session');

    await expect(service.startSession('missing-session')).rejects.toThrow(
      'Session not found: missing-session'
    );

    const sentinelGeneration = service.getStopGeneration('sentinel-session');
    const generationAfterFailure = service.getStopGeneration('missing-session');
    expect(sentinelGeneration).toBeGreaterThan(generationBeforeFailure);
    expect(generationAfterFailure).toBeGreaterThan(sentinelGeneration);
  });

  it('does not create a client when stop completes during the initial session lookup', async () => {
    const { service, session, repository, runtimeManager } = createLifecycleHarness();
    let resolveSession!: (value: typeof session) => void;
    repository.getSessionById.mockReturnValueOnce(
      new Promise<typeof session>((resolve) => {
        resolveSession = resolve;
      })
    );
    const startupGeneration = service.getStopGeneration('session-1');

    const startResult = service.startSession('session-1').catch((error) => error);
    await vi.waitFor(() => {
      expect(repository.getSessionById).toHaveBeenCalledWith('session-1');
    });

    await service.stopSession('session-1');
    resolveSession(session);

    await expect(startResult).resolves.toEqual(
      expect.objectContaining({ message: 'Session is currently being stopped' })
    );
    expect(runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
    expect(service.getStopGeneration('session-1')).not.toBe(startupGeneration);
  });

  it('releases the stop generation when startup fails before creating a runtime', async () => {
    const { service, runtimeManager } = createLifecycleHarness();
    runtimeManager.getOrCreateClient.mockRejectedValueOnce(new Error('spawn failed'));
    const generationBeforeFailure = service.getStopGeneration('session-1');

    await expect(service.startSession('session-1')).rejects.toThrow('spawn failed');

    const sentinelGeneration = service.getStopGeneration('sentinel-session');
    expect(sentinelGeneration).toBeGreaterThan(generationBeforeFailure);
    expect(service.getStopGeneration('session-1')).toBeGreaterThan(sentinelGeneration);
  });

  it('does not retain a stop generation when client lookup cannot find the session', async () => {
    const { service, repository } = createLifecycleHarness();
    repository.getSessionById.mockResolvedValueOnce(null);
    const generationBeforeFailure = service.getStopGeneration('missing-session');

    await expect(service.getOrCreateSessionClient('missing-session')).rejects.toThrow(
      'Session not found: missing-session'
    );

    const sentinelGeneration = service.getStopGeneration('sentinel-session');
    const generationAfterFailure = service.getStopGeneration('missing-session');
    expect(sentinelGeneration).toBeGreaterThan(generationBeforeFailure);
    expect(generationAfterFailure).toBeGreaterThan(sentinelGeneration);
  });

  it('releases the stop generation when record-based client creation fails', async () => {
    const { service, session, runtimeManager } = createLifecycleHarness();
    runtimeManager.getOrCreateClient.mockRejectedValueOnce(new Error('spawn failed'));
    const generationBeforeFailure = service.getStopGeneration('session-1');

    await expect(service.getOrCreateSessionClientFromRecord(session as never)).rejects.toThrow(
      'spawn failed'
    );

    const sentinelGeneration = service.getStopGeneration('sentinel-session');
    expect(sentinelGeneration).toBeGreaterThan(generationBeforeFailure);
    expect(service.getStopGeneration('session-1')).toBeGreaterThan(sentinelGeneration);
  });

  it('does not release a stop generation still owned by a concurrent startup', async () => {
    let resolveFirstPreset!: (preset: 'STRICT') => void;
    const firstPreset = new Promise<'STRICT'>((resolve) => {
      resolveFirstPreset = resolve;
    });
    const getPermissionPreset = vi
      .fn(() => Promise.resolve<'STRICT'>('STRICT'))
      .mockReturnValueOnce(firstPreset);
    const { service, runtimeManager } = createLifecycleHarness({ getPermissionPreset });
    const startupGeneration = service.getStopGeneration('session-1');

    const firstStart = service.startSession('session-1');
    await vi.waitFor(() => {
      expect(getPermissionPreset).toHaveBeenCalledTimes(1);
    });

    runtimeManager.getOrCreateClient.mockRejectedValueOnce(new Error('second spawn failed'));
    await expect(service.startSession('session-1')).rejects.toThrow('second spawn failed');

    resolveFirstPreset('STRICT');

    await expect(firstStart).resolves.toBeUndefined();
    expect(service.isStopGenerationCurrent('session-1', startupGeneration)).toBe(true);
  });

  it('finalizes an in-flight prompt after a duplicate running-session start is rejected', async () => {
    const harness = createLifecycleHarness();
    await harness.service.startSession('session-1', { initialPrompt: '' });
    harness.runtimeManager.getClient.mockReturnValue(harness.handle);
    const promptResult = createDeferred<{ stopReason: string }>();
    const promptRuntimeManager = {
      sendPrompt: vi.fn(() => promptResult.promise),
    };
    const promptDomainService = new SessionDomainService();
    const promptService = new SessionService({
      runtimeManager: promptRuntimeManager as never,
      sessionDomainService: promptDomainService,
      acpEventProcessor: {
        getWorkspaceId: vi.fn(() => undefined),
        beginPromptTurn: vi.fn(() => 'attempt-1'),
        finishPromptTurn: vi.fn(),
        finalizeOrphanedToolCalls: vi.fn(),
      } as never,
      promptTurnCompletionService: { schedule: vi.fn() } as never,
      lifecycleEventService: { record: vi.fn() } as never,
      lifecycleGate: {
        getGeneration: (sessionId) => harness.service.getStopGeneration(sessionId),
        isGenerationCurrent: (sessionId, generation) =>
          harness.service.isStopGenerationCurrent(sessionId, generation),
        isSessionStopping: (sessionId) => harness.service.isSessionStopping(sessionId),
      },
    });

    const prompt = promptService.sendAcpMessage('session-1', [{ type: 'text', text: 'hello' }]);
    await vi.waitFor(() => {
      expect(promptRuntimeManager.sendPrompt).toHaveBeenCalledOnce();
    });
    expect(promptDomainService.getRuntimeSnapshot('session-1')).toMatchObject({
      phase: 'running',
      activity: 'WORKING',
    });

    await expect(harness.service.startSession('session-1', { initialPrompt: '' })).rejects.toThrow(
      'Session is already running'
    );
    promptResult.resolve({ stopReason: 'end_turn' });
    await prompt;

    expect(promptDomainService.getRuntimeSnapshot('session-1')).toMatchObject({
      phase: 'idle',
      activity: 'IDLE',
    });
  });

  it('dispatches queued notifications after startup presets and skips the default continue prompt', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage, sessionConfigService } =
      createLifecycleHarness();
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      createPendingWorkspaceNotification({ id: 'notif-1' }),
      createPendingWorkspaceNotification({ id: 'notif-2' }),
    ] as never);

    await service.startSession('session-1');

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).not.toHaveBeenCalled();
    const startupPresetOrder =
      sessionConfigService.applyStartupModePreset.mock.invocationCallOrder[0];
    const permissionPresetOrder =
      sessionConfigService.applyConfiguredPermissionPreset.mock.invocationCallOrder[0];
    const dispatchOrder = tryDispatchNextMessage.mock.invocationCallOrder[0];
    expect(startupPresetOrder).toBeDefined();
    expect(permissionPresetOrder).toBeDefined();
    expect(dispatchOrder).toBeDefined();
    expect(startupPresetOrder!).toBeLessThan(dispatchOrder!);
    expect(permissionPresetOrder!).toBeLessThan(dispatchOrder!);
  });

  it('still sends an explicit initial prompt after queued notification dispatch starts', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createLifecycleHarness();
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      createPendingWorkspaceNotification(),
    ] as never);

    await service.startSession('session-1', { initialPrompt: 'Follow up' });

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).toHaveBeenCalledWith('session-1', 'Follow up');
    const dispatchOrder = tryDispatchNextMessage.mock.invocationCallOrder[0];
    const sendOrder = sendSessionMessage.mock.invocationCallOrder[0];
    expect(dispatchOrder).toBeDefined();
    expect(sendOrder).toBeDefined();
    expect(dispatchOrder!).toBeLessThan(sendOrder!);
  });

  it('does not complete startup when stop finishes during the initial prompt', async () => {
    let resolvePrompt!: (value: undefined) => void;
    const pendingPrompt = new Promise<undefined>((resolve) => {
      resolvePrompt = resolve;
    });
    const { service, sendSessionMessage } = createLifecycleHarness();
    sendSessionMessage.mockReturnValueOnce(pendingPrompt);
    const startupGeneration = service.getStopGeneration('session-1');

    const startResult = service.startSession('session-1').catch((error) => error);
    await vi.waitFor(() => {
      expect(sendSessionMessage).toHaveBeenCalledWith('session-1', 'Continue with the task.');
    });

    await service.stopSession('session-1');
    resolvePrompt(undefined);

    await expect(startResult).resolves.toEqual(
      expect.objectContaining({ message: 'Session is currently being stopped' })
    );
    expect(service.getStopGeneration('session-1')).not.toBe(startupGeneration);
  });

  it('does not create a client after stop completes during permission resolution', async () => {
    let resolvePreset!: (preset: 'STRICT') => void;
    const pendingPreset = new Promise<'STRICT'>((resolve) => {
      resolvePreset = resolve;
    });
    const getPermissionPreset = vi.fn(() => pendingPreset);
    const { service, sendSessionMessage, runtimeManager } = createLifecycleHarness({
      getPermissionPreset,
    });
    const startupGeneration = service.getStopGeneration('session-1');

    const startResult = service.startSession('session-1').catch((error) => error);
    await vi.waitFor(() => {
      expect(getPermissionPreset).toHaveBeenCalled();
    });

    await service.stopSession('session-1');
    resolvePreset('STRICT');

    await expect(startResult).resolves.toEqual(
      expect.objectContaining({ message: 'Session is currently being stopped' })
    );
    expect(runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(service.getStopGeneration('session-1')).not.toBe(startupGeneration);
  });

  it('does not publish startup capabilities after stop completes during snapshot persistence', async () => {
    const harness = createLifecycleHarness();
    const snapshotPersistence = createDeferred<void>();
    harness.sessionConfigService.persistAcpConfigSnapshot.mockReturnValueOnce(
      snapshotPersistence.promise
    );

    const startResult = harness.service
      .startSession('session-1', { initialPrompt: '' })
      .catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(harness.sessionConfigService.persistAcpConfigSnapshot).toHaveBeenCalledOnce();
    });

    const stopPromise = harness.service.stopSession('session-1');
    await vi.waitFor(() => {
      expect(harness.runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
    });
    const firstSettlement = await Promise.race([
      stopPromise.then(() => 'stopped' as const),
      new Promise<'blocked'>((resolve) => {
        setImmediate(() => resolve('blocked'));
      }),
    ]);

    expect(firstSettlement).toBe('blocked');
    snapshotPersistence.resolve(undefined);
    await stopPromise;

    await expect(startResult).resolves.toEqual(
      expect.objectContaining({ message: 'Session is currently being stopped' })
    );
    expect(harness.sessionDomainService.emitDelta).not.toHaveBeenCalled();
  });

  it('keeps stop ahead of startup during durable running-state persistence', async () => {
    const harness = createLifecycleHarness();
    const runningPersistence = createDeferred<typeof harness.session>();
    harness.repository.updateSession.mockReturnValueOnce(runningPersistence.promise);

    const startResult = harness.service
      .startSession('session-1', { initialPrompt: '' })
      .catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(harness.repository.updateSession).toHaveBeenCalledWith('session-1', {
        status: SessionStatus.RUNNING,
      });
    });

    const stopPromise = harness.service.stopSession('session-1');
    await vi.waitFor(() => {
      expect(harness.runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
    });
    const firstSettlement = await Promise.race([
      stopPromise.then(() => 'stopped' as const),
      new Promise<'blocked'>((resolve) => {
        setImmediate(() => resolve('blocked'));
      }),
    ]);

    expect(firstSettlement).toBe('blocked');
    runningPersistence.resolve(harness.session);
    await stopPromise;
    await expect(startResult).resolves.toEqual(
      expect.objectContaining({ message: 'Session is currently being stopped' })
    );
    expect(harness.sessionDomainService.getRuntimeSnapshot('session-1')).toMatchObject({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
    });
  });

  it('does not fail startup when queued notification dispatch fails', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createLifecycleHarness({
      tryDispatchNextMessage: () => Promise.reject(new Error('dispatch failed')),
    });
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      createPendingWorkspaceNotification(),
    ] as never);

    await expect(service.startSession('session-1')).resolves.toBeUndefined();

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it.each([
    'session lookup',
    'client creation',
    'startup preset',
    'permission preset',
    'notification recovery',
    'initial prompt',
  ] as const)('cancels startup after stop begins during %s', async (boundary) => {
    const harness = createLifecycleHarness();
    let releaseBoundary: () => void;
    let boundaryReached: () => boolean;

    if (boundary === 'session lookup') {
      const deferred = createDeferred<typeof harness.session>();
      harness.repository.getSessionById.mockReturnValueOnce(deferred.promise);
      releaseBoundary = () => deferred.resolve(harness.session);
      boundaryReached = () => harness.repository.getSessionById.mock.calls.length > 0;
    } else if (boundary === 'client creation') {
      const deferred = createDeferred<typeof harness.handle>();
      harness.runtimeManager.getOrCreateClient.mockReturnValueOnce(deferred.promise);
      releaseBoundary = () => deferred.resolve(harness.handle);
      boundaryReached = () => harness.runtimeManager.getOrCreateClient.mock.calls.length > 0;
    } else if (boundary === 'startup preset') {
      const deferred = createDeferred<void>();
      harness.sessionConfigService.applyStartupModePreset.mockReturnValueOnce(deferred.promise);
      releaseBoundary = () => deferred.resolve(undefined);
      boundaryReached = () =>
        harness.sessionConfigService.applyStartupModePreset.mock.calls.length > 0;
    } else if (boundary === 'permission preset') {
      const deferred = createDeferred<void>();
      harness.sessionConfigService.applyConfiguredPermissionPreset.mockReturnValueOnce(
        deferred.promise
      );
      releaseBoundary = () => deferred.resolve(undefined);
      boundaryReached = () =>
        harness.sessionConfigService.applyConfiguredPermissionPreset.mock.calls.length > 0;
    } else if (boundary === 'notification recovery') {
      const deferred = createDeferred<never[]>();
      vi.mocked(workspaceNotificationService.listPendingForDelivery).mockReturnValueOnce(
        deferred.promise
      );
      releaseBoundary = () => deferred.resolve([]);
      boundaryReached = () =>
        vi.mocked(workspaceNotificationService.listPendingForDelivery).mock.calls.length > 0;
    } else {
      const deferred = createDeferred<void>();
      harness.sendSessionMessage.mockReturnValueOnce(deferred.promise);
      releaseBoundary = () => deferred.resolve(undefined);
      boundaryReached = () => harness.sendSessionMessage.mock.calls.length > 0;
    }

    const startupResult = harness.service.startSession('session-1').catch((error) => error);
    await vi.waitFor(() => {
      expect(boundaryReached()).toBe(true);
    });
    const runningWritesBeforeStop = harness.repository.updateSession.mock.calls.filter(
      ([, update]) => update.status === SessionStatus.RUNNING
    ).length;

    const stopPromise = harness.service.stopSession('session-1');
    await vi.waitFor(() => {
      expect(harness.runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
    });
    releaseBoundary();
    await stopPromise;

    await expect(startupResult).resolves.toEqual(
      expect.objectContaining({ message: 'Session is currently being stopped' })
    );
    const runningWritesAfterStop = harness.repository.updateSession.mock.calls.filter(
      ([, update]) => update.status === SessionStatus.RUNNING
    ).length;
    expect(runningWritesAfterStop).toBe(runningWritesBeforeStop);
  });
});
