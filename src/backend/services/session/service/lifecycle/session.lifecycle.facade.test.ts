import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionLifecycleWorkspaceBridge } from '@/backend/services/session/service/bridges';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { workspaceNotificationService } from '@/backend/services/workspace';
import { WorkspaceStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  SessionLifecycleService,
  type SessionLifecycleServiceDependencies,
} from './session.lifecycle.service';
import type { SessionContextService } from './session-context.service';
import {
  createLifecycleHarness,
  createPendingWorkspaceNotification,
} from './session-lifecycle.test-helpers';
import type { SessionLifecycleGate } from './session-lifecycle-gate';
import type { SessionStartupCoordinator } from './session-startup.coordinator';
import type { SessionTerminationCoordinator } from './session-termination.coordinator';
import type { SessionWorkflowFinalizer } from './session-workflow-finalizer';

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

  it('forwards its public lifecycle contract to configured collaborators', async () => {
    const startupFailure = new Error('startup rejected');
    const stopFailure = new Error('stop rejected');
    const persistFailure = new Error('persist rejected');
    const startupCoordinator = {
      configure: vi.fn<SessionStartupCoordinator['configure']>(),
      startSession: vi
        .fn<SessionStartupCoordinator['startSession']>()
        .mockRejectedValueOnce(startupFailure),
      restartSession: vi.fn<SessionStartupCoordinator['restartSession']>(async () => undefined),
      getOrCreateSessionClient: vi.fn<SessionStartupCoordinator['getOrCreateSessionClient']>(
        async () => 'client-by-id'
      ),
      getOrCreateSessionClientFromRecord: vi.fn<
        SessionStartupCoordinator['getOrCreateSessionClientFromRecord']
      >(async () => 'client-by-record'),
      ensureSubagentBrowseSession: vi.fn<SessionStartupCoordinator['ensureSubagentBrowseSession']>(
        async () => true
      ),
    } satisfies SessionLifecycleServiceDependencies['startupCoordinator'];
    const terminationCoordinator = {
      configure: vi.fn<SessionTerminationCoordinator['configure']>(),
      stopSession: vi.fn<SessionTerminationCoordinator['stopSession']>(async () => undefined),
      stopWorkspaceSessions: vi.fn<SessionTerminationCoordinator['stopWorkspaceSessions']>(
        async () => undefined
      ),
      stopAllClients: vi.fn<SessionTerminationCoordinator['stopAllClients']>(async () => undefined),
    } satisfies SessionLifecycleServiceDependencies['terminationCoordinator'];
    const workflowFinalizer = {
      configure: vi.fn<SessionWorkflowFinalizer['configure']>(),
      persistClosedSession: vi.fn<SessionWorkflowFinalizer['persistClosedSession']>(
        async () => undefined
      ),
      recoverStaleRunningSessions: vi.fn<SessionWorkflowFinalizer['recoverStaleRunningSessions']>(
        async () => 3
      ),
    } satisfies SessionLifecycleServiceDependencies['workflowFinalizer'];
    const lifecycleGate = {
      isSessionStopping: vi.fn<SessionLifecycleGate['isSessionStopping']>(() => true),
      getGeneration: vi.fn<SessionLifecycleGate['getGeneration']>(() => 7),
      isGenerationCurrent: vi.fn<SessionLifecycleGate['isGenerationCurrent']>(() => false),
    } satisfies SessionLifecycleServiceDependencies['lifecycleGate'];
    const sessionOptions = {
      workingDir: '/delegated/worktree',
      resumeProviderSessionId: 'provider-session-1',
      systemPrompt: 'delegated prompt',
      model: 'delegated-model',
      workspaceStatus: WorkspaceStatus.READY,
    };
    const contextService = {
      getOptions: vi.fn<SessionContextService['getOptions']>(async () => sessionOptions),
    } satisfies SessionLifecycleServiceDependencies['contextService'];
    const runtimeManager = {
      getClient: vi.fn<AcpRuntimeManager['getClient']>(() => unsafeCoerce('runtime-client')),
      isSessionWorking: vi.fn<AcpRuntimeManager['isSessionWorking']>(() => true),
      isStopInProgress: vi.fn<AcpRuntimeManager['isStopInProgress']>(() => false),
    } satisfies SessionLifecycleServiceDependencies['runtimeManager'];
    const sessionDomainService = {
      getRuntimeSnapshot: vi.fn<SessionDomainService['getRuntimeSnapshot']>(() => ({
        phase: 'idle' as const,
        processState: 'stopped' as const,
        activity: 'IDLE' as const,
        updatedAt: '2026-08-12T00:00:00.000Z',
      })),
    } satisfies SessionLifecycleServiceDependencies['sessionDomainService'];
    const service = new SessionLifecycleService({
      startupCoordinator,
      terminationCoordinator,
      workflowFinalizer,
      lifecycleGate,
      contextService,
      runtimeManager,
      sessionDomainService,
    });
    const workspaceBridge = unsafeCoerce<SessionLifecycleWorkspaceBridge>({
      markSessionIdle: vi.fn(),
    });
    const messageQueueBridge = { tryDispatchNextMessage: vi.fn(async () => undefined) };
    const autoIterationExit = { onAutoIterationSessionExit: vi.fn() };
    const startOptions = { initialPrompt: 'Continue exactly' };
    const stopOptions = { reason: 'USER_STOP' as const };
    const clientOptions = { model: 'delegated-model', reasoningEffort: 'high' };
    const session = unsafeCoerce<AgentSessionRecord>({ id: 'record-session' });

    const guardedOperations = [
      ['start', () => service.startSession('unconfigured-start'), startupCoordinator.startSession],
      [
        'restart',
        () => service.restartSession('unconfigured-restart'),
        startupCoordinator.restartSession,
      ],
      ['stop', () => service.stopSession('unconfigured-stop'), terminationCoordinator.stopSession],
      [
        'workspace stop',
        () => service.stopWorkspaceSessions('unconfigured-workspace'),
        terminationCoordinator.stopWorkspaceSessions,
      ],
      ['stop all', () => service.stopAllClients(), terminationCoordinator.stopAllClients],
      [
        'client creation',
        () => service.getOrCreateSessionClient('unconfigured-client'),
        startupCoordinator.getOrCreateSessionClient,
      ],
      [
        'record client creation',
        () => service.getOrCreateSessionClientFromRecord(session),
        startupCoordinator.getOrCreateSessionClientFromRecord,
      ],
      [
        'browse client creation',
        () => service.ensureSubagentBrowseSession('unconfigured-browse'),
        startupCoordinator.ensureSubagentBrowseSession,
      ],
    ] as const;

    for (const [operation, invoke, collaborator] of guardedOperations) {
      await expect(invoke()).rejects.toThrow('SessionLifecycleService not configured');
      expect(collaborator).not.toHaveBeenCalled();
      expect(operation).toBeTruthy();
    }
    expect(() => service.persistClosedSession('unconfigured-closed')).toThrow(
      'SessionLifecycleService not configured'
    );
    expect(workflowFinalizer.persistClosedSession).not.toHaveBeenCalled();
    expect(() => service.recoverStaleRunningSessions()).toThrow(
      'SessionLifecycleService not configured'
    );
    expect(workflowFinalizer.recoverStaleRunningSessions).not.toHaveBeenCalled();

    service.configure({
      workspace: workspaceBridge,
      messageQueue: messageQueueBridge,
      autoIterationExit,
    });
    await expect(service.startSession('start-session', startOptions)).rejects.toBe(startupFailure);
    await service.restartSession('restart-session', startOptions);
    await expect(service.getOrCreateSessionClient('client-session', clientOptions)).resolves.toBe(
      'client-by-id'
    );
    await expect(service.getOrCreateSessionClientFromRecord(session, clientOptions)).resolves.toBe(
      'client-by-record'
    );
    await expect(service.ensureSubagentBrowseSession('browse-session')).resolves.toBe(true);
    await expect(service.stopSession('stop-session', stopOptions)).resolves.toBeUndefined();
    await expect(
      service.stopWorkspaceSessions('workspace-session', stopOptions)
    ).resolves.toBeUndefined();
    await expect(service.stopAllClients(3210)).resolves.toBeUndefined();
    expect(service.getSessionClient('runtime-session')).toBe('runtime-client');
    expect(service.getRuntimeSnapshot('runtime-session')).toEqual({
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    await expect(service.getSessionOptions('options-session')).resolves.toEqual(sessionOptions);
    await expect(service.persistClosedSession('closed-session')).resolves.toBeUndefined();
    await expect(service.recoverStaleRunningSessions()).resolves.toBe(3);
    expect(service.isSessionStopping('gate-session')).toBe(true);
    expect(service.getStopGeneration('gate-session')).toBe(7);
    expect(service.isStopGenerationCurrent('gate-session', 6)).toBe(false);

    expect(workflowFinalizer.configure).toHaveBeenCalledExactlyOnceWith({
      workspace: workspaceBridge,
      autoIterationExit,
    });
    expect(terminationCoordinator.configure).toHaveBeenCalledExactlyOnceWith({
      workspace: workspaceBridge,
    });
    expect(startupCoordinator.configure).toHaveBeenCalledExactlyOnceWith({
      messageQueue: messageQueueBridge,
    });
    expect(startupCoordinator.startSession).toHaveBeenCalledWith('start-session', startOptions);
    expect(startupCoordinator.restartSession).toHaveBeenCalledWith('restart-session', startOptions);
    expect(startupCoordinator.getOrCreateSessionClient).toHaveBeenCalledWith(
      'client-session',
      clientOptions
    );
    expect(startupCoordinator.getOrCreateSessionClientFromRecord).toHaveBeenCalledWith(
      session,
      clientOptions
    );
    expect(startupCoordinator.ensureSubagentBrowseSession).toHaveBeenCalledWith('browse-session');
    expect(terminationCoordinator.stopSession).toHaveBeenCalledWith('stop-session', stopOptions);
    expect(terminationCoordinator.stopWorkspaceSessions).toHaveBeenCalledWith(
      'workspace-session',
      stopOptions
    );
    expect(terminationCoordinator.stopAllClients).toHaveBeenCalledWith(3210);
    expect(runtimeManager.getClient).toHaveBeenCalledWith('runtime-session');
    expect(contextService.getOptions).toHaveBeenCalledWith('options-session');
    expect(workflowFinalizer.persistClosedSession).toHaveBeenCalledWith('closed-session');
    expect(workflowFinalizer.recoverStaleRunningSessions).toHaveBeenCalledOnce();
    expect(lifecycleGate.isSessionStopping).toHaveBeenCalledWith('gate-session');
    expect(lifecycleGate.getGeneration).toHaveBeenCalledWith('gate-session');
    expect(lifecycleGate.isGenerationCurrent).toHaveBeenCalledWith('gate-session', 6);

    terminationCoordinator.stopSession.mockRejectedValueOnce(stopFailure);
    workflowFinalizer.persistClosedSession.mockRejectedValueOnce(persistFailure);
    await expect(service.stopSession('rejected-stop')).rejects.toBe(stopFailure);
    await expect(service.persistClosedSession('rejected-persist')).rejects.toBe(persistFailure);

    const rejectedDelegations = [
      {
        name: 'restart',
        reject: (error: Error) => startupCoordinator.restartSession.mockRejectedValueOnce(error),
        invoke: () => service.restartSession('rejected-restart'),
      },
      {
        name: 'workspace stop',
        reject: (error: Error) =>
          terminationCoordinator.stopWorkspaceSessions.mockRejectedValueOnce(error),
        invoke: () => service.stopWorkspaceSessions('rejected-workspace'),
      },
      {
        name: 'stop all',
        reject: (error: Error) =>
          terminationCoordinator.stopAllClients.mockRejectedValueOnce(error),
        invoke: () => service.stopAllClients(),
      },
      {
        name: 'client acquisition',
        reject: (error: Error) =>
          startupCoordinator.getOrCreateSessionClient.mockRejectedValueOnce(error),
        invoke: () => service.getOrCreateSessionClient('rejected-client'),
      },
      {
        name: 'record client acquisition',
        reject: (error: Error) =>
          startupCoordinator.getOrCreateSessionClientFromRecord.mockRejectedValueOnce(error),
        invoke: () => service.getOrCreateSessionClientFromRecord(session),
      },
      {
        name: 'browse acquisition',
        reject: (error: Error) =>
          startupCoordinator.ensureSubagentBrowseSession.mockRejectedValueOnce(error),
        invoke: () => service.ensureSubagentBrowseSession('rejected-browse'),
      },
      {
        name: 'option read',
        reject: (error: Error) => contextService.getOptions.mockRejectedValueOnce(error),
        invoke: () => service.getSessionOptions('rejected-options'),
      },
      {
        name: 'stale-session recovery',
        reject: (error: Error) =>
          workflowFinalizer.recoverStaleRunningSessions.mockRejectedValueOnce(error),
        invoke: () => service.recoverStaleRunningSessions(),
      },
    ] as const;

    for (const { name, reject, invoke } of rejectedDelegations) {
      const failure = new Error(`${name} rejected`);
      reject(failure);
      await expect(invoke()).rejects.toBe(failure);
    }

    const synchronousThrowCases = [
      {
        name: 'session client read',
        throwFrom: (error: Error) =>
          runtimeManager.getClient.mockImplementationOnce(() => {
            throw error;
          }),
        invoke: () => service.getSessionClient('throwing-client-read'),
      },
      {
        name: 'runtime snapshot domain read',
        throwFrom: (error: Error) =>
          sessionDomainService.getRuntimeSnapshot.mockImplementationOnce(() => {
            throw error;
          }),
        invoke: () => service.getRuntimeSnapshot('throwing-domain-snapshot'),
      },
      {
        name: 'runtime snapshot client read',
        throwFrom: (error: Error) =>
          runtimeManager.getClient.mockImplementationOnce(() => {
            throw error;
          }),
        invoke: () => service.getRuntimeSnapshot('throwing-runtime-snapshot'),
      },
      {
        name: 'runtime snapshot activity read',
        throwFrom: (error: Error) =>
          runtimeManager.isSessionWorking.mockImplementationOnce(() => {
            throw error;
          }),
        invoke: () => service.getRuntimeSnapshot('throwing-runtime-activity'),
      },
      {
        name: 'runtime snapshot stop read',
        throwFrom: (error: Error) => {
          runtimeManager.getClient.mockReturnValueOnce(undefined);
          runtimeManager.isStopInProgress.mockImplementationOnce(() => {
            throw error;
          });
        },
        invoke: () => service.getRuntimeSnapshot('throwing-runtime-stop'),
      },
      {
        name: 'stopping gate read',
        throwFrom: (error: Error) =>
          lifecycleGate.isSessionStopping.mockImplementationOnce(() => {
            throw error;
          }),
        invoke: () => service.isSessionStopping('throwing-stopping-gate'),
      },
      {
        name: 'generation gate read',
        throwFrom: (error: Error) =>
          lifecycleGate.getGeneration.mockImplementationOnce(() => {
            throw error;
          }),
        invoke: () => service.getStopGeneration('throwing-generation-gate'),
      },
      {
        name: 'generation-current gate read',
        throwFrom: (error: Error) =>
          lifecycleGate.isGenerationCurrent.mockImplementationOnce(() => {
            throw error;
          }),
        invoke: () => service.isStopGenerationCurrent('throwing-current-gate', 1),
      },
    ] as const;

    for (const { name, throwFrom, invoke } of synchronousThrowCases) {
      const failure = new Error(`${name} threw`);
      throwFrom(failure);
      expect(invoke).toThrow(failure);
    }

    const configurationThrowCases = [
      {
        name: 'workflow finalizer configuration',
        throwFrom: (error: Error) =>
          workflowFinalizer.configure.mockImplementationOnce(() => {
            throw error;
          }),
      },
      {
        name: 'termination configuration',
        throwFrom: (error: Error) =>
          terminationCoordinator.configure.mockImplementationOnce(() => {
            throw error;
          }),
      },
      {
        name: 'startup configuration',
        throwFrom: (error: Error) =>
          startupCoordinator.configure.mockImplementationOnce(() => {
            throw error;
          }),
      },
    ] as const;

    for (const { name, throwFrom } of configurationThrowCases) {
      const failure = new Error(`${name} threw`);
      throwFrom(failure);
      expect(() => service.configure({ workspace: workspaceBridge })).toThrow(failure);
    }

    const retryWorkspaceBridge = unsafeCoerce<SessionLifecycleWorkspaceBridge>({
      markSessionIdle: vi.fn(),
    });
    const retryMessageQueueBridge = { tryDispatchNextMessage: vi.fn(async () => undefined) };
    const retryAutoIterationExit = { onAutoIterationSessionExit: vi.fn() };
    const reconfigurationFailures = [
      {
        name: 'workflow finalizer',
        throwFrom: (error: Error) =>
          workflowFinalizer.configure.mockImplementationOnce(() => {
            throw error;
          }),
      },
      {
        name: 'termination coordinator',
        throwFrom: (error: Error) =>
          terminationCoordinator.configure.mockImplementationOnce(() => {
            throw error;
          }),
      },
      {
        name: 'startup coordinator',
        throwFrom: (error: Error) =>
          startupCoordinator.configure.mockImplementationOnce(() => {
            throw error;
          }),
      },
    ] as const;

    for (const { name, throwFrom } of reconfigurationFailures) {
      service.configure({ workspace: workspaceBridge });
      const failure = new Error(`${name} reconfiguration failed`);
      throwFrom(failure);

      expect(() =>
        service.configure({
          workspace: retryWorkspaceBridge,
          messageQueue: retryMessageQueueBridge,
          autoIterationExit: retryAutoIterationExit,
        })
      ).toThrow(failure);

      const operationCallsBeforeFailure = startupCoordinator.startSession.mock.calls.length;
      await expect(service.startSession(`blocked-after-${name}`)).rejects.toThrow(
        'SessionLifecycleService not configured'
      );
      expect(startupCoordinator.startSession).toHaveBeenCalledTimes(operationCallsBeforeFailure);

      service.configure({
        workspace: retryWorkspaceBridge,
        messageQueue: retryMessageQueueBridge,
        autoIterationExit: retryAutoIterationExit,
      });
      await expect(service.startSession(`restored-after-${name}`)).resolves.toBeUndefined();
      expect(workflowFinalizer.configure).toHaveBeenLastCalledWith({
        workspace: retryWorkspaceBridge,
        autoIterationExit: retryAutoIterationExit,
      });
      expect(terminationCoordinator.configure).toHaveBeenLastCalledWith({
        workspace: retryWorkspaceBridge,
      });
      expect(startupCoordinator.configure).toHaveBeenLastCalledWith({
        messageQueue: retryMessageQueueBridge,
      });
    }
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
