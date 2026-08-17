import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceNotificationService } from '@/backend/services/workspace';
import { WorkspaceStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionLifecycleService } from './session.lifecycle.service';
import {
  createLifecycleHarness,
  createPendingWorkspaceNotification,
} from './session-lifecycle.test-helpers';
import { SessionStartupCoordinator } from './session-startup.coordinator';
import { SessionTerminationCoordinator } from './session-termination.coordinator';

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

it('creates isolated lifecycle harness state', () => {
  const first = createLifecycleHarness();
  const second = createLifecycleHarness();
  expect(first.repository.getSessionById).not.toBe(second.repository.getSessionById);
  expect(first.runtimeManager.getClient).not.toBe(second.runtimeManager.getClient);
});

it('preserves an explicit null lifecycle provider process ID', () =>
  expect(
    createLifecycleHarness({ providerProcessPid: null }).session.providerProcessPid
  ).toBeNull());

describe('SessionLifecycleFacade', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      createPendingWorkspaceNotification(),
    ] as never);
  });

  it('fails during construction when required external ports are missing', () => {
    expect(
      () =>
        new SessionLifecycleService(
          unsafeCoerce({
            repository: {},
          })
        )
    ).toThrow('SessionLifecycleService requires context and ACP environment ports');
  });

  it('delegates session option reads to the injected context service', async () => {
    const { service, contextService } = createLifecycleHarness();
    const options = {
      workingDir: '/delegated/worktree',
      resumeProviderSessionId: 'provider-session-1',
      systemPrompt: 'delegated prompt',
      model: 'delegated-model',
      workspaceStatus: WorkspaceStatus.READY,
    };
    const getOptions = vi.spyOn(contextService, 'getOptions').mockResolvedValueOnce(options);

    await expect(service.getSessionOptions('session-1')).resolves.toEqual(options);

    expect(getOptions).toHaveBeenCalledWith('session-1');
  });

  it('delegates every startup entry point through the configured coordinator', async () => {
    const startSession = vi
      .spyOn(SessionStartupCoordinator.prototype, 'startSession')
      .mockResolvedValueOnce(undefined);
    const restartSession = vi
      .spyOn(SessionStartupCoordinator.prototype, 'restartSession')
      .mockResolvedValueOnce(undefined);
    const getOrCreateSessionClient = vi
      .spyOn(SessionStartupCoordinator.prototype, 'getOrCreateSessionClient')
      .mockResolvedValueOnce('client-by-id');
    const getOrCreateSessionClientFromRecord = vi
      .spyOn(SessionStartupCoordinator.prototype, 'getOrCreateSessionClientFromRecord')
      .mockResolvedValueOnce('client-by-record');
    const ensureSubagentBrowseSession = vi
      .spyOn(SessionStartupCoordinator.prototype, 'ensureSubagentBrowseSession')
      .mockResolvedValueOnce(true);
    const { service, session } = createLifecycleHarness();
    const options = { initialPrompt: 'Resume the task', startupModePreset: 'plan' } as const;
    const clientOptions = { model: 'claude-opus', reasoningEffort: 'high' };

    await service.startSession('session-1', options);
    await service.restartSession('session-2', options);
    await expect(service.getOrCreateSessionClient('session-3', clientOptions)).resolves.toBe(
      'client-by-id'
    );
    await expect(service.getOrCreateSessionClientFromRecord(session, clientOptions)).resolves.toBe(
      'client-by-record'
    );
    await expect(service.ensureSubagentBrowseSession('session-4')).resolves.toBe(true);

    expect(startSession).toHaveBeenCalledWith('session-1', options);
    expect(restartSession).toHaveBeenCalledWith('session-2', options);
    expect(getOrCreateSessionClient).toHaveBeenCalledWith('session-3', clientOptions);
    expect(getOrCreateSessionClientFromRecord).toHaveBeenCalledWith(session, clientOptions);
    expect(ensureSubagentBrowseSession).toHaveBeenCalledWith('session-4');
  });

  it('forwards explicit and workspace stops to the termination coordinator', async () => {
    const stopSession = vi
      .spyOn(SessionTerminationCoordinator.prototype, 'stopSession')
      .mockResolvedValueOnce(undefined);
    const stopWorkspaceSessions = vi
      .spyOn(SessionTerminationCoordinator.prototype, 'stopWorkspaceSessions')
      .mockResolvedValueOnce(undefined);
    const stopAllClients = vi
      .spyOn(SessionTerminationCoordinator.prototype, 'stopAllClients')
      .mockResolvedValue(undefined);
    const { service } = createLifecycleHarness();
    const sessionOptions = {
      cleanupTransientRatchetSession: false,
      recordLifecycleEvent: false,
      reason: 'USER_STOP',
    } as const;
    const workspaceOptions = { reason: 'WORKSPACE_ARCHIVED' } as const;

    await expect(service.stopSession('session-exact', sessionOptions)).resolves.toBeUndefined();
    await expect(
      service.stopWorkspaceSessions('workspace-exact', workspaceOptions)
    ).resolves.toBeUndefined();
    await expect(service.stopAllClients(4321)).resolves.toBeUndefined();
    await expect(service.stopAllClients()).resolves.toBeUndefined();

    expect(stopSession).toHaveBeenCalledWith('session-exact', sessionOptions);
    expect(stopWorkspaceSessions).toHaveBeenCalledWith('workspace-exact', workspaceOptions);
    expect(stopAllClients).toHaveBeenNthCalledWith(1, 4321);
    expect(stopAllClients).toHaveBeenNthCalledWith(2, 5000);
  });

  it('preserves termination coordinator rejections', async () => {
    const sessionFailure = new Error('session stop rejected');
    const workspaceFailure = new Error('workspace stop rejected');
    const shutdownFailure = new Error('shutdown rejected');
    vi.spyOn(SessionTerminationCoordinator.prototype, 'stopSession').mockRejectedValueOnce(
      sessionFailure
    );
    vi.spyOn(
      SessionTerminationCoordinator.prototype,
      'stopWorkspaceSessions'
    ).mockRejectedValueOnce(workspaceFailure);
    vi.spyOn(SessionTerminationCoordinator.prototype, 'stopAllClients').mockRejectedValueOnce(
      shutdownFailure
    );
    const { service } = createLifecycleHarness();

    await expect(service.stopSession('session-rejected')).rejects.toBe(sessionFailure);
    await expect(service.stopWorkspaceSessions('workspace-rejected')).rejects.toBe(
      workspaceFailure
    );
    await expect(service.stopAllClients()).rejects.toBe(shutdownFailure);
  });

  it('skips the restart default continue prompt when notifications are queued', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createLifecycleHarness();

    await service.restartSession('session-1');

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('sends an explicit restart prompt after queued notification dispatch starts', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createLifecycleHarness();

    await service.restartSession('session-1', {
      initialPrompt: 'Fix the failing checks',
      startupModePreset: 'non_interactive',
    });

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).toHaveBeenCalledWith('session-1', 'Fix the failing checks');
    const dispatchOrder = tryDispatchNextMessage.mock.invocationCallOrder[0];
    const sendOrder = sendSessionMessage.mock.invocationCallOrder[0];
    expect(dispatchOrder).toBeDefined();
    expect(sendOrder).toBeDefined();
    expect(dispatchOrder!).toBeLessThan(sendOrder!);
  });
});
