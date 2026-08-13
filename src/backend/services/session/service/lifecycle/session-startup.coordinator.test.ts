import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpBrowseSessionUnavailableError } from '@/backend/services/session/service/acp/acp-runtime-manager';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceNotificationService } from '@/backend/services/workspace';
import { SessionStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  createDeferred,
  createLifecycleHarness,
  createPendingWorkspaceNotification,
} from './session-lifecycle.test-helpers';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ ...process.env }),
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

describe('SessionStartupCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([]);
    vi.mocked(workspaceNotificationService.markDelivered).mockResolvedValue();
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

    const generationAfterFailure = service.getStopGeneration('missing-session');
    expect(generationAfterFailure).not.toBe(generationBeforeFailure);
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

    expect(service.getStopGeneration('session-1')).not.toBe(generationBeforeFailure);
  });

  it('does not retain a stop generation when client lookup cannot find the session', async () => {
    const { service, repository } = createLifecycleHarness();
    repository.getSessionById.mockResolvedValueOnce(null);
    const generationBeforeFailure = service.getStopGeneration('missing-session');

    await expect(service.getOrCreateSessionClient('missing-session')).rejects.toThrow(
      'Session not found: missing-session'
    );

    const generationAfterFailure = service.getStopGeneration('missing-session');
    expect(generationAfterFailure).not.toBe(generationBeforeFailure);
  });

  it('releases the stop generation when record-based client creation fails', async () => {
    const { service, session, runtimeManager } = createLifecycleHarness();
    runtimeManager.getOrCreateClient.mockRejectedValueOnce(new Error('spawn failed'));
    const generationBeforeFailure = service.getStopGeneration('session-1');

    await expect(service.getOrCreateSessionClientFromRecord(session as never)).rejects.toThrow(
      'spawn failed'
    );

    expect(service.getStopGeneration('session-1')).not.toBe(generationBeforeFailure);
  });

  it('does not release a stop generation still owned by a concurrent startup', async () => {
    type UserSettings = Awaited<ReturnType<typeof userSettingsService.get>>;
    let resolveFirstSettings!: (settings: UserSettings) => void;
    const firstSettings = new Promise<UserSettings>((resolve) => {
      resolveFirstSettings = resolve;
    });
    vi.mocked(userSettingsService.get)
      .mockReturnValueOnce(firstSettings)
      .mockResolvedValueOnce(
        unsafeCoerce<UserSettings>({
          defaultWorkspacePermissions: 'STRICT',
          ratchetPermissions: 'YOLO',
        })
      );
    const { service, runtimeManager } = createLifecycleHarness();
    const startupGeneration = service.getStopGeneration('session-1');

    const firstStart = service.startSession('session-1');
    await vi.waitFor(() => {
      expect(userSettingsService.get).toHaveBeenCalledTimes(1);
    });

    runtimeManager.getOrCreateClient.mockRejectedValueOnce(new Error('second spawn failed'));
    await expect(service.startSession('session-1')).rejects.toThrow('second spawn failed');

    resolveFirstSettings(
      unsafeCoerce<UserSettings>({
        defaultWorkspacePermissions: 'STRICT',
        ratchetPermissions: 'YOLO',
      })
    );

    await expect(firstStart).resolves.toBeUndefined();
    expect(service.isStopGenerationCurrent('session-1', startupGeneration)).toBe(true);
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
    type UserSettings = Awaited<ReturnType<typeof userSettingsService.get>>;
    let resolveSettings!: (settings: UserSettings) => void;
    const pendingSettings = new Promise<UserSettings>((resolve) => {
      resolveSettings = resolve;
    });
    vi.mocked(userSettingsService.get).mockReturnValueOnce(pendingSettings);
    const { service, sendSessionMessage, runtimeManager } = createLifecycleHarness();
    const startupGeneration = service.getStopGeneration('session-1');

    const startResult = service.startSession('session-1').catch((error) => error);
    await vi.waitFor(() => {
      expect(userSettingsService.get).toHaveBeenCalled();
    });

    await service.stopSession('session-1');
    resolveSettings(
      unsafeCoerce<UserSettings>({
        defaultWorkspacePermissions: 'STRICT',
        ratchetPermissions: 'YOLO',
      })
    );

    await expect(startResult).resolves.toEqual(
      expect.objectContaining({ message: 'Session is currently being stopped' })
    );
    expect(runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(service.getStopGeneration('session-1')).not.toBe(startupGeneration);
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
