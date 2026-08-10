import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpClientOptions } from '@/backend/services/session/service/acp';
import { AcpBrowseSessionUnavailableError } from '@/backend/services/session/service/acp/acp-runtime-manager';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService, workspaceNotificationService } from '@/backend/services/workspace';
import type { ChatMessage } from '@/shared/acp-protocol';
import { SessionStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionLifecycleService } from './session.lifecycle.service';
import { SessionLifecycleEventService } from './session-lifecycle-event.service';

vi.mock('./closed-session-persistence.service', () => ({
  closedSessionPersistenceService: {
    persistClosedSession: vi.fn(async () => undefined),
  },
}));

import { closedSessionPersistenceService } from './closed-session-persistence.service';

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

function createLifecycleService(options?: {
  enqueue?: SessionDomainService['enqueue'];
  transcript?: ChatMessage[];
  historyHydrationSource?: 'jsonl' | 'acp_fallback' | 'none';
  tryDispatchNextMessage?: (sessionId: string) => Promise<void>;
}) {
  const sessionDomainService = {
    appendClaudeEvent: vi.fn((_sessionId: string, _message: unknown) => 1),
    emitDelta: vi.fn(),
    hasQueuedMessage: vi.fn((_sessionId: string, _messageId: string) => false),
    enqueue:
      options?.enqueue ??
      vi.fn((_sessionId: string, _message: unknown) => ({ position: 0 }) as const),
    getTranscriptSnapshot: vi.fn(() => options?.transcript ?? []),
    getHistoryHydrationSource: vi.fn(() => options?.historyHydrationSource ?? 'none'),
  };
  const tryDispatchNextMessage = options?.tryDispatchNextMessage ?? vi.fn(async () => undefined);

  const service = new SessionLifecycleService({
    repository: {} as never,
    promptBuilder: {} as never,
    runtimeManager: { isStopInProgress: vi.fn(() => false) } as never,
    sessionDomainService: sessionDomainService as unknown as SessionDomainService,
    sessionPermissionService: {} as never,
    sessionConfigService: {} as never,
    acpEventProcessor: {} as never,
    promptTurnCompletionService: {} as never,
    retryService: {} as never,
    sendSessionMessage: vi.fn(async () => undefined),
    lifecycleEventService: { hydrate: vi.fn(async () => undefined) } as never,
  });
  service.configure({
    workspace: {
      markSessionRunning: vi.fn(),
      markSessionIdle: vi.fn(),
      recordRatchetSessionEnd: vi.fn(async () => undefined),
      resetPRDiscoveryBackoff: vi.fn(async () => true),
    },
    messageQueue: { tryDispatchNextMessage },
  });

  return { service, sessionDomainService, tryDispatchNextMessage };
}

async function deliverPendingChildNotifications(
  service: SessionLifecycleService,
  sessionId = 'session-1',
  workspaceId = 'workspace-1'
) {
  return await (
    service as unknown as {
      deliverPendingChildNotifications(sessionId: string, workspaceId: string): Promise<number>;
    }
  ).deliverPendingChildNotifications(sessionId, workspaceId);
}

function getStopGenerations(service: SessionLifecycleService): Map<string, number> {
  return (
    service as unknown as {
      stopGenerations: Map<string, number>;
    }
  ).stopGenerations;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createStoppableLifecycleService() {
  const repository = {
    getSessionsByWorkspaceId: vi.fn(async () => [
      { id: 'session-running', status: SessionStatus.RUNNING },
      { id: 'session-runtime-only', status: SessionStatus.COMPLETED },
      { id: 'session-browse-only', status: SessionStatus.IDLE },
      { id: 'session-idle', status: SessionStatus.IDLE },
    ]),
  };
  const runtimeManager = {
    isSessionRunning: vi.fn((sessionId: string) => sessionId === 'session-runtime-only'),
    getBrowseClient: vi.fn(() => undefined),
    isBrowseOnlySession: vi.fn((sessionId: string) => sessionId === 'session-browse-only'),
  };
  const service = new SessionLifecycleService({
    repository: repository as never,
    promptBuilder: {} as never,
    runtimeManager: runtimeManager as never,
    sessionDomainService: {} as never,
    sessionPermissionService: {} as never,
    sessionConfigService: {} as never,
    acpEventProcessor: {} as never,
    promptTurnCompletionService: {} as never,
    retryService: {} as never,
    sendSessionMessage: vi.fn(async () => undefined),
    lifecycleEventService: { hydrate: vi.fn(async () => undefined) } as never,
  });
  const stopSession = vi.fn(
    (_sessionId: string, _options?: unknown): Promise<void> => Promise.resolve()
  );
  (service as unknown as { stopSession: typeof stopSession }).stopSession = stopSession;

  return { service, repository, runtimeManager, stopSession };
}

function createStopReasonLifecycleService(options?: { providerProcessPid?: number | null }) {
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workflow: 'code',
    providerProcessPid: options?.providerProcessPid ?? 4242,
  };
  const repository = {
    getSessionById: vi.fn(async () => session),
    updateSessionIfStatus: vi.fn(async () => session),
    updateSession: vi.fn(async () => session),
  };
  const runtimeManager = {
    isStopInProgress: vi.fn(() => false),
    isSessionRunning: vi.fn(() => false),
    isBrowseOnlySession: vi.fn(() => false),
    isSessionWorking: vi.fn(() => false),
    getClient: vi.fn(() => undefined),
    stopClient: vi.fn(async () => undefined),
  };
  const lifecycleEventService = {
    record: vi.fn(
      async (_input: {
        workspaceId: string;
        sessionId: string;
        kind: string;
        reason: string;
        message: string;
        dedupeKey: string;
      }) => null
    ),
    hydrate: vi.fn(),
  };
  const service = new SessionLifecycleService(
    unsafeCoerce({
      repository,
      promptBuilder: {},
      runtimeManager,
      sessionDomainService: {
        clearQueuedWork: vi.fn(),
        getRuntimeSnapshot: vi.fn(() => ({
          phase: 'idle',
          processState: 'stopped',
          activity: 'IDLE',
          updatedAt: '2026-07-30T00:00:00.000Z',
        })),
        setRuntimeSnapshot: vi.fn(),
        markProcessExit: vi.fn(),
        clearSession: vi.fn(),
      },
      sessionPermissionService: { cancelPendingRequests: vi.fn() },
      sessionConfigService: {},
      acpEventProcessor: {
        createRuntimeEventHandler: vi.fn(() => ({})),
        clearStreamingState: vi.fn(),
        clearReplaySuppression: vi.fn(),
        clearSessionContext: vi.fn(),
        clearSessionState: vi.fn(),
        finalizeOrphanedToolCalls: vi.fn(),
      },
      promptTurnCompletionService: { clearSession: vi.fn() },
      retryService: { run: vi.fn(async (operation: () => Promise<unknown>) => await operation()) },
      lifecycleEventService,
      sendSessionMessage: vi.fn(),
    })
  );
  const createRuntimeHandlers = () =>
    service as unknown as {
      setupAcpEventHandler(sessionId: string): {
        onExit?: (sessionId: string, exitCode: number | null) => Promise<void>;
      };
    };
  const runtimeHandlers = createRuntimeHandlers().setupAcpEventHandler('session-1');
  return {
    service,
    repository,
    lifecycleEventService,
    runtimeManager,
    runtimeHandlers,
    createRuntimeHandlers: () => createRuntimeHandlers().setupAcpEventHandler('session-1'),
  };
}

describe('SessionLifecycleService stopWorkspaceSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops running sessions and runtime-only sessions', async () => {
    const { service, repository, runtimeManager, stopSession } = createStoppableLifecycleService();

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
    const { service, stopSession } = createStoppableLifecycleService();
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

describe('SessionLifecycleService stop causes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['USER_STOP', 'Session stopped by you.'],
    ['SESSION_CLOSED', 'Session closed by you.'],
    ['WORKSPACE_ARCHIVED', 'Session stopped because the workspace was archived.'],
    ['SYSTEM_STOP', 'Session stopped by the system.'],
  ] as const)('records %s before stopping the runtime', async (reason, message) => {
    const { service, lifecycleEventService, runtimeManager } = createStopReasonLifecycleService();

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
    const first = createStopReasonLifecycleService();
    const reconstructed = createStopReasonLifecycleService();

    await first.service.stopSession('session-1', { reason: 'USER_STOP' });
    await reconstructed.service.stopSession('session-1', { reason: 'USER_STOP' });

    const firstKey = first.lifecycleEventService.record.mock.calls[0]?.[0]?.dedupeKey;
    const reconstructedKey =
      reconstructed.lifecycleEventService.record.mock.calls[0]?.[0]?.dedupeKey;
    expect(firstKey).toMatch(/^session-stop:/);
    expect(reconstructedKey).toMatch(/^session-stop:/);
    expect(reconstructedKey).not.toBe(firstKey);
  });

  it('records an unexpected process exit once with its runtime incarnation and exit code', async () => {
    const { lifecycleEventService, runtimeHandlers } = createStopReasonLifecycleService();

    await runtimeHandlers.onExit?.('session-1', 1);

    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'SESSION_STOPPED',
        reason: 'UNEXPECTED_EXIT',
        message: 'Session stopped: agent process exited unexpectedly (code 1).',
        dedupeKey: expect.stringMatching(
          /^process-exit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:1$/
        ),
      })
    );
  });

  it('records an unexpected process exit when the status update fails', async () => {
    const { lifecycleEventService, repository, runtimeHandlers } =
      createStopReasonLifecycleService();
    repository.updateSession.mockRejectedValueOnce(new Error('database write failed'));

    await runtimeHandlers.onExit?.('session-1', 1);

    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'UNEXPECTED_EXIT',
        dedupeKey: expect.stringMatching(/^process-exit:.+:1$/),
      })
    );
  });

  it('does not collapse repeated null-PID exits from separate runtime incarnations', async () => {
    const { lifecycleEventService, createRuntimeHandlers } = createStopReasonLifecycleService({
      providerProcessPid: null,
    });

    await createRuntimeHandlers().onExit?.('session-1', 1);
    await createRuntimeHandlers().onExit?.('session-1', 1);

    const dedupeKeys = lifecycleEventService.record.mock.calls.map(
      ([recordInput]) => recordInput.dedupeKey
    );
    expect(dedupeKeys).toHaveLength(2);
    expect(new Set(dedupeKeys).size).toBe(2);
    expect(dedupeKeys).toEqual([
      expect.stringMatching(/^process-exit:.+:1$/),
      expect.stringMatching(/^process-exit:.+:1$/),
    ]);
  });

  it('does not label a deliberate stop as an unexpected exit', async () => {
    const { lifecycleEventService, runtimeManager, runtimeHandlers } =
      createStopReasonLifecycleService();
    runtimeManager.isStopInProgress.mockReturnValue(true);

    await runtimeHandlers.onExit?.('session-1', 0);

    expect(lifecycleEventService.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'UNEXPECTED_EXIT' })
    );
  });

  it('can clean up a failed startup without recording a stop event', async () => {
    const { service, lifecycleEventService, runtimeManager } = createStopReasonLifecycleService();

    await service.stopSession('session-1', { recordLifecycleEvent: false });

    expect(lifecycleEventService.record).not.toHaveBeenCalled();
    expect(runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
  });
});

describe('SessionLifecycleService closed transcript persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates durable lifecycle rows before persisting a closed transcript', async () => {
    const domain = new SessionDomainService();
    const hydrateProviderHistory = vi.fn(() => {
      domain.replaceTranscript('session-1', [
        {
          id: 'provider-user-1',
          source: 'user',
          text: 'Original provider conversation',
          timestamp: '2026-07-30T12:00:00.000Z',
          order: 0,
        },
      ]);
      return Promise.resolve();
    });
    const lifecycleEventService = new SessionLifecycleEventService({
      store: {
        upsert: vi.fn(),
        findBySessionId: vi.fn(async () => [
          {
            id: 'event-1',
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            kind: 'TURN_INTERRUPTED',
            reason: 'PROMPT_TIMEOUT',
            message: 'Turn stopped: reached the 4-hour limit.',
            dedupeKey: 'prompt-timeout',
            createdAt: new Date('2026-07-30T12:22:23.353Z'),
          },
        ]),
      } as never,
      sessionDomainService: domain,
    });
    const hydrateLifecycleEvents = vi.spyOn(lifecycleEventService, 'hydrate');
    domain.clearSession('session-1');
    const repository = {
      getSessionById: vi.fn(async () => ({
        id: 'session-1',
        workspaceId: 'workspace-1',
        name: 'Chat',
        workflow: 'user',
        provider: 'CLAUDE',
        model: 'claude-sonnet',
        createdAt: new Date('2026-07-30T12:00:00.000Z'),
      })),
    };
    vi.mocked(workspaceDataService.findById).mockResolvedValue({
      id: 'workspace-1',
      worktreePath: '/tmp/worktree',
    } as never);
    const service = new SessionLifecycleService(
      unsafeCoerce({
        repository,
        promptBuilder: {},
        runtimeManager: {},
        sessionDomainService: domain,
        sessionPermissionService: {},
        sessionConfigService: {},
        acpEventProcessor: {},
        promptTurnCompletionService: {},
        retryService: {},
        sendSessionMessage: vi.fn(),
        lifecycleEventService,
        hydrateProviderHistory,
      })
    );

    await (
      service as unknown as { persistClosedSession(sessionId: string): Promise<void> }
    ).persistClosedSession('session-1');

    expect(closedSessionPersistenceService.persistClosedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        messages: expect.arrayContaining([
          expect.objectContaining({ id: 'provider-user-1' }),
          expect.objectContaining({ id: 'session-lifecycle:event-1' }),
        ]),
      })
    );
    expect(hydrateProviderHistory).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ provider: 'CLAUDE' })
    );
    expect(hydrateProviderHistory.mock.invocationCallOrder[0]).toBeLessThan(
      hydrateLifecycleEvents.mock.invocationCallOrder[0]!
    );
  });
});

describe('SessionLifecycleService graceful shutdown', () => {
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

  it('continues runtime shutdown when lifecycle recording stalls', async () => {
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

describe('SessionLifecycleService pending workspace notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds pending workspace notifications to the UI transcript and ACP dispatch queue', async () => {
    const createdAt = new Date('2026-06-22T10:30:00.000Z');
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt,
      },
      {
        id: 'notif-child',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'child-workspace',
        sourceWorkspaceName: 'Child Workspace',
        sourceProjectName: 'Child Project',
        message: 'The branch is ready for review.',
        direction: 'CHILD_TO_PARENT',
        deliveredAt: null,
        createdAt,
      },
    ] as never);
    vi.mocked(workspaceNotificationService.markDelivered).mockResolvedValue();
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleService();

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(sessionDomainService.appendClaudeEvent).toHaveBeenNthCalledWith(
      1,
      'session-1',
      expect.objectContaining({
        type: 'parent_workspace_update',
        parentWorkspaceId: 'parent-workspace',
        parentWorkspaceName: 'Parent Workspace',
        parentProjectName: 'Parent Project',
        text: 'Please check the failing test.',
        timestamp: '2026-06-22T10:30:00.000Z',
      })
    );
    expect(sessionDomainService.appendClaudeEvent).toHaveBeenNthCalledWith(
      2,
      'session-1',
      expect.objectContaining({
        type: 'child_workspace_update',
        childWorkspaceId: 'child-workspace',
        childWorkspaceName: 'Child Workspace',
        childProjectName: 'Child Project',
        text: 'The branch is ready for review.',
        timestamp: '2026-06-22T10:30:00.000Z',
      })
    );
    expect(sessionDomainService.enqueue).toHaveBeenNthCalledWith(
      1,
      'session-1',
      expect.objectContaining({
        id: 'workspace-notification-notif-parent',
        text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.\n\n<!-- factory-factory-workspace-notification:notif-parent -->',
        timestamp: '2026-06-22T10:30:00.000Z',
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      })
    );
    expect(sessionDomainService.enqueue).toHaveBeenNthCalledWith(
      2,
      'session-1',
      expect.objectContaining({
        id: 'workspace-notification-notif-child',
        text: '[Message from child workspace "Child Workspace"]: The branch is ready for review.\n\n<!-- factory-factory-workspace-notification:notif-child -->',
      })
    );
    expect(enqueuedCount).toBe(2);
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
    expect(workspaceNotificationService.markDelivered).not.toHaveBeenCalled();
  });

  it('does not enqueue notifications found after the startup stop generation changes', async () => {
    let resolvePending!: (notifications: unknown[]) => void;
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockReturnValue(
      new Promise((resolve) => {
        resolvePending = resolve;
      }) as never
    );
    const { service, sessionDomainService } = createLifecycleService();

    const deliveryPromise = deliverPendingChildNotifications(service);
    await vi.waitFor(() => {
      expect(workspaceNotificationService.listPendingForDelivery).toHaveBeenCalledWith(
        'workspace-1'
      );
    });

    getStopGenerations(service).set('session-1', service.getStopGeneration('session-1') + 1);
    resolvePending([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt: new Date('2026-06-22T10:30:00.000Z'),
      },
    ]);

    await expect(deliveryPromise).resolves.toBe(0);
    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalled();
  });

  it('leaves notifications pending when enqueue fails', async () => {
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt: new Date('2026-06-22T10:30:00.000Z'),
      },
    ] as never);
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleService({
      enqueue: vi.fn(() => ({ error: 'Queue full' })),
    });

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(0);
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalled();
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
    expect(workspaceNotificationService.markDelivered).not.toHaveBeenCalled();
  });

  it('does not dispatch pending notifications ahead of an existing queued message', async () => {
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt: new Date('2026-06-22T10:30:00.000Z'),
      },
    ] as never);
    vi.mocked(workspaceNotificationService.markDelivered).mockResolvedValue();
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleService();

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(1);
    expect(sessionDomainService.enqueue).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        id: 'workspace-notification-notif-parent',
      })
    );
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
    expect(workspaceNotificationService.markDelivered).not.toHaveBeenCalled();
  });

  it('reports a pending workspace notification that is already queued as dispatchable', async () => {
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt: new Date('2026-06-22T10:30:00.000Z'),
      },
    ] as never);
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleService();
    sessionDomainService.hasQueuedMessage.mockReturnValue(true);

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(1);
    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalled();
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
    expect(workspaceNotificationService.markDelivered).not.toHaveBeenCalled();
  });

  it('does not re-enqueue a notification queued during transcript reconciliation', async () => {
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt: new Date('2026-06-22T10:30:00.000Z'),
      },
    ] as never);
    const { service, sessionDomainService } = createLifecycleService();
    let queuedByLiveDelivery = false;
    sessionDomainService.hasQueuedMessage.mockImplementation(() => queuedByLiveDelivery);
    sessionDomainService.getTranscriptSnapshot.mockImplementation(() => {
      queuedByLiveDelivery = true;
      return [];
    });

    const dispatchableCount = await deliverPendingChildNotifications(service);

    expect(dispatchableCount).toBe(1);
    expect(sessionDomainService.hasQueuedMessage).toHaveBeenCalledTimes(2);
    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalled();
  });

  it('marks an already-committed pending notification delivered without requeueing it', async () => {
    const createdAt = new Date('2026-06-22T10:30:00.000Z');
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt,
      },
    ] as never);
    vi.mocked(workspaceNotificationService.markDelivered).mockResolvedValue();
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleService({
      transcript: [
        {
          id: 'workspace-notification-notif-parent',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.',
          timestamp: createdAt.toISOString(),
          order: 1,
        },
      ],
    });

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(0);
    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalled();
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
    expect(workspaceNotificationService.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });

  it('matches an already-committed pending notification with a provider-generated ID', async () => {
    const createdAt = new Date('2026-06-22T10:30:00.000Z');
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt,
      },
    ] as never);
    vi.mocked(workspaceNotificationService.markDelivered).mockResolvedValue();
    const { service, sessionDomainService } = createLifecycleService({
      historyHydrationSource: 'jsonl',
      transcript: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000-0',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.\n\n<!-- factory-factory-workspace-notification:notif-parent -->',
          timestamp: createdAt.toISOString(),
          order: 0,
        },
      ],
    });

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(0);
    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalled();
    expect(workspaceNotificationService.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });

  it('does not match identical user text without a notification marker', async () => {
    const createdAt = new Date('2026-06-22T10:30:00.000Z');
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt,
      },
    ] as never);
    const { service, sessionDomainService } = createLifecycleService({
      historyHydrationSource: 'jsonl',
      transcript: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000-0',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.',
          timestamp: createdAt.toISOString(),
          order: 0,
        },
      ],
    });

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(1);
    expect(sessionDomainService.enqueue).toHaveBeenCalledOnce();
    expect(workspaceNotificationService.markDelivered).not.toHaveBeenCalled();
  });

  it('consumes one provider-generated transcript entry once for duplicate pending notifications', async () => {
    const oldestCreatedAt = new Date('2026-06-22T10:30:00.000Z');
    const newestCreatedAt = new Date('2026-06-22T10:31:00.000Z');
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent-oldest',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt: oldestCreatedAt,
      },
      {
        id: 'notif-parent-newest',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt: newestCreatedAt,
      },
    ] as never);
    vi.mocked(workspaceNotificationService.markDelivered).mockResolvedValue();
    const { service, sessionDomainService } = createLifecycleService({
      historyHydrationSource: 'jsonl',
      transcript: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000-0',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.\n\n<!-- factory-factory-workspace-notification:notif-parent-oldest -->',
          timestamp: oldestCreatedAt.toISOString(),
          order: 0,
        },
      ],
    });

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(1);
    expect(sessionDomainService.enqueue).toHaveBeenCalledOnce();
    expect(workspaceNotificationService.markDelivered).toHaveBeenCalledTimes(1);
    expect(workspaceNotificationService.markDelivered).toHaveBeenCalledWith([
      'notif-parent-oldest',
    ]);
  });

  it("does not let an older duplicate consume a later notification's exact transcript entry", async () => {
    const oldestCreatedAt = new Date('2026-06-22T10:30:00.000Z');
    const newestCreatedAt = new Date('2026-06-22T10:31:00.000Z');
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent-A',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt: oldestCreatedAt,
      },
      {
        id: 'notif-parent-B',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt: newestCreatedAt,
      },
    ] as never);
    vi.mocked(workspaceNotificationService.markDelivered).mockResolvedValue();
    const { service, sessionDomainService } = createLifecycleService({
      historyHydrationSource: 'jsonl',
      transcript: [
        {
          id: 'workspace-notification-notif-parent-B',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.',
          timestamp: newestCreatedAt.toISOString(),
          order: 0,
        },
      ],
    });

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(1);
    expect(sessionDomainService.enqueue).toHaveBeenCalledOnce();
    expect(sessionDomainService.enqueue).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'workspace-notification-notif-parent-A' })
    );
    expect(workspaceNotificationService.markDelivered).toHaveBeenCalledTimes(1);
    expect(workspaceNotificationService.markDelivered).toHaveBeenCalledWith(['notif-parent-B']);
  });

  it('does not content-match a normal live user entry with canonical notification text', async () => {
    const createdAt = new Date('2026-06-22T10:30:00.000Z');
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt,
      },
    ] as never);
    const { service, sessionDomainService } = createLifecycleService({
      transcript: [
        {
          id: 'session-1-42',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.',
          timestamp: createdAt.toISOString(),
          order: 0,
        },
      ],
    });

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(1);
    expect(sessionDomainService.enqueue).toHaveBeenCalledOnce();
    expect(workspaceNotificationService.markDelivered).not.toHaveBeenCalled();
  });

  it('does not requeue an already-committed pending notification when delivery retry fails', async () => {
    const createdAt = new Date('2026-06-22T10:30:00.000Z');
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt,
      },
    ] as never);
    vi.mocked(workspaceNotificationService.markDelivered).mockRejectedValue(
      new Error('database unavailable')
    );
    const { service, sessionDomainService } = createLifecycleService({
      transcript: [
        {
          id: 'workspace-notification-notif-parent',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.',
          timestamp: createdAt.toISOString(),
          order: 1,
        },
      ],
    });

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(0);
    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalled();
    expect(workspaceNotificationService.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });

  it('does not treat UI-only workspace update cards as delivered user messages', async () => {
    const createdAt = new Date('2026-06-22T10:30:00.000Z');
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      {
        id: 'notif-parent',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'parent-workspace',
        sourceWorkspaceName: 'Parent Workspace',
        sourceProjectName: 'Parent Project',
        message: 'Please check the failing test.',
        direction: 'PARENT_TO_CHILD',
        deliveredAt: null,
        createdAt,
      },
    ] as never);
    vi.mocked(workspaceNotificationService.markDelivered).mockResolvedValue();
    const { service, sessionDomainService } = createLifecycleService({
      transcript: [
        {
          id: 'session-1-1',
          source: 'agent',
          message: {
            type: 'parent_workspace_update',
            parentWorkspaceId: 'parent-workspace',
            parentWorkspaceName: 'Parent Workspace',
            parentProjectName: 'Parent Project',
            text: 'Please check the failing test.',
            timestamp: createdAt.toISOString(),
          },
          timestamp: createdAt.toISOString(),
          order: 1,
        },
      ],
    });

    const enqueuedCount = await deliverPendingChildNotifications(service);

    expect(enqueuedCount).toBe(1);
    expect(sessionDomainService.enqueue).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        id: 'workspace-notification-notif-parent',
      })
    );
    expect(workspaceNotificationService.markDelivered).not.toHaveBeenCalled();
  });
});

function createStartableLifecycleService(options?: {
  pendingNotificationCount?: number;
  tryDispatchNextMessage?: () => Promise<void>;
  provider?: 'CLAUDE' | 'CODEX';
  providerSessionId?: string | null;
  worktreePath?: string | null;
}) {
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workflow: 'code',
    provider: options?.provider ?? 'CLAUDE',
    providerSessionId: options?.providerSessionId ?? null,
    providerMetadata: null,
    model: 'claude-sonnet',
  };
  const workspace = {
    id: 'workspace-1',
    name: 'Workspace',
    description: null,
    projectId: 'project-1',
    worktreePath: options?.worktreePath === undefined ? '/tmp/workspace' : options.worktreePath,
    branchName: 'feature/test',
    isAutoGeneratedBranch: false,
    hasHadSessions: false,
    runScriptPort: null,
    parentWorkspaceId: null,
    creationMetadata: null,
  };
  const handle = {
    provider: options?.provider ?? 'CLAUDE',
    providerSessionId: options?.providerSessionId ?? 'provider-session-1',
    configOptions: [],
    isPromptInFlight: false,
    getSubagentBrowseCapability: vi.fn(() => ({
      version: 1 as const,
      list: true as const,
      read: true as const,
      notifications: true as const,
    })),
  };
  const repository = {
    getSessionById: vi.fn(async (): Promise<typeof session | null> => session),
    getWorkspaceById: vi.fn(async () => workspace),
    getProjectById: vi.fn(),
    markWorkspaceHasHadSessions: vi.fn(async () => undefined),
    updateSession: vi.fn(async () => session),
    updateSessionIfStatus: vi.fn(async () => null),
  };
  const promptBuilder = {
    shouldInjectBranchRename: vi.fn(() => false),
    buildSystemPrompt: vi.fn(() => ({
      workflowPrompt: undefined,
      systemPrompt: 'system prompt',
      injectedBranchRename: false,
    })),
  };
  const runtimeManager = {
    isStopInProgress: vi.fn(() => false),
    isSessionRunning: vi.fn(() => false),
    isBrowseOnlySession: vi.fn(() => false),
    getClient: vi.fn(() => undefined),
    getBrowseClient: vi.fn(() => undefined),
    getPendingClient: vi.fn(() => undefined),
    getSubagentBrowseCapability: vi.fn<
      (sessionId: string) => ReturnType<typeof handle.getSubagentBrowseCapability> | null
    >(() => null),
    getOrCreateClient: vi.fn(async (_sessionId: string, _options: AcpClientOptions) => handle),
    stopClient: vi.fn(async () => undefined),
    isSessionWorking: vi.fn(() => false),
  };
  const sessionDomainService = {
    setRuntimeSnapshot: vi.fn(),
    emitDelta: vi.fn(),
    isHistoryHydrated: vi.fn(() => false),
    getTranscriptSnapshot: vi.fn(() => []),
    getRuntimeSnapshot: vi.fn(() => ({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-07-15T00:00:00.000Z',
    })),
    clearQueuedWork: vi.fn(),
    clearSession: vi.fn(),
    markProcessExit: vi.fn(),
  };
  const sessionConfigService = {
    applyConfiguredReasoningEffort: vi.fn(async () => undefined),
    applyStartupModePreset: vi.fn(async () => undefined),
    applyConfiguredPermissionPreset: vi.fn(async () => undefined),
    persistAcpConfigSnapshot: vi.fn(async () => undefined),
    buildAcpChatBarCapabilities: vi.fn(() => ({})),
  };
  const acpEventProcessor = {
    createRuntimeEventHandler: vi.fn(() => ({})),
    registerSessionContext: vi.fn(),
    setReplaySuppression: vi.fn(),
    clearSessionState: vi.fn(),
    clearStreamingState: vi.fn(),
    clearReplaySuppression: vi.fn(),
    finalizeOrphanedToolCalls: vi.fn(),
    clearSessionContext: vi.fn(),
  };
  const tryDispatchNextMessage = vi.fn(options?.tryDispatchNextMessage ?? (async () => undefined));
  const sendSessionMessage = vi.fn(async () => undefined);

  const service = new SessionLifecycleService({
    repository: repository as never,
    promptBuilder: promptBuilder as never,
    runtimeManager: runtimeManager as never,
    sessionDomainService: sessionDomainService as never,
    sessionPermissionService: { cancelPendingRequests: vi.fn() } as never,
    sessionConfigService: sessionConfigService as never,
    acpEventProcessor: acpEventProcessor as never,
    promptTurnCompletionService: { clearSession: vi.fn() } as never,
    retryService: {
      run: vi.fn(async (operation: () => Promise<unknown>) => await operation()),
    } as never,
    sendSessionMessage,
    lifecycleEventService: { hydrate: vi.fn(async () => undefined), record: vi.fn() } as never,
  });
  service.configure({
    workspace: {
      markSessionRunning: vi.fn(),
      markSessionIdle: vi.fn(),
      recordRatchetSessionEnd: vi.fn(async () => undefined),
      resetPRDiscoveryBackoff: vi.fn(async () => true),
    },
    messageQueue: { tryDispatchNextMessage },
  });
  const deliverPendingChildNotifications = vi.fn(
    async () => options?.pendingNotificationCount ?? 0
  );
  (
    service as unknown as {
      deliverPendingChildNotifications(sessionId: string, workspaceId: string): Promise<number>;
    }
  ).deliverPendingChildNotifications = deliverPendingChildNotifications;

  return {
    service,
    session,
    handle,
    repository,
    sendSessionMessage,
    tryDispatchNextMessage,
    sessionConfigService,
    runtimeManager,
    sessionDomainService,
    acpEventProcessor,
    deliverPendingChildNotifications,
  };
}

describe('SessionLifecycleService startSession pending workspace notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores a stopped Codex session for browsing without activating it', async () => {
    const {
      service,
      repository,
      runtimeManager,
      handle,
      sessionDomainService,
      deliverPendingChildNotifications,
    } = createStartableLifecycleService({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
      pendingNotificationCount: 2,
    });
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
    expect(deliverPendingChildNotifications).not.toHaveBeenCalled();
    expect(sessionDomainService.setRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it('does not spawn a browse client without a stored provider session', async () => {
    const { service, runtimeManager } = createStartableLifecycleService({
      provider: 'CODEX',
      providerSessionId: null,
    });

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(false);

    expect(runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
  });

  it('returns unsupported when the stopped session has no usable worktree', async () => {
    const { service, runtimeManager } = createStartableLifecycleService({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
      worktreePath: null,
    });

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(false);

    expect(runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
  });

  it('returns unsupported when the provider cannot restore the stored session', async () => {
    const { service, runtimeManager } = createStartableLifecycleService({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
    });
    runtimeManager.getOrCreateClient.mockRejectedValueOnce(
      new AcpBrowseSessionUnavailableError('loadSession unsupported')
    );

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(false);
  });

  it('stops a browse-only client when the provider lacks sub-agent browsing', async () => {
    const { service, runtimeManager, acpEventProcessor } = createStartableLifecycleService({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
    });
    runtimeManager.isBrowseOnlySession.mockReturnValue(true);

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(false);

    expect(runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
    expect(acpEventProcessor.clearSessionState).toHaveBeenCalledWith('session-1');
  });

  it('does not let a failed browse creation clear a concurrent active startup context', async () => {
    const { service, handle, runtimeManager, acpEventProcessor } = createStartableLifecycleService({
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

  it('omits provider-session persistence from browse-only runtime handlers', () => {
    const { service } = createStartableLifecycleService({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
    });
    const handlers = (
      service as unknown as {
        setupAcpEventHandler(
          sessionId: string,
          options: { persistProviderSessionId: boolean }
        ): { onSessionId?: (sessionId: string, providerSessionId: string) => Promise<void> };
      }
    ).setupAcpEventHandler('session-1', { persistProviderSessionId: false });

    expect(handlers.onSessionId).toBeUndefined();
  });

  it('promotes a restored browse client through the normal active startup path', async () => {
    const {
      service,
      repository,
      runtimeManager,
      handle,
      deliverPendingChildNotifications,
      sessionConfigService,
    } = createStartableLifecycleService({
      provider: 'CODEX',
      providerSessionId: 'provider-session-existing',
      pendingNotificationCount: 1,
    });
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
    expect(deliverPendingChildNotifications).toHaveBeenCalledTimes(1);
  });

  it('does not retain a stop generation for a missing session', async () => {
    const { service, repository } = createStartableLifecycleService();
    repository.getSessionById.mockResolvedValueOnce(null);

    await expect(service.startSession('missing-session')).rejects.toThrow(
      'Session not found: missing-session'
    );

    expect(getStopGenerations(service).has('missing-session')).toBe(false);
  });

  it('does not create a client when stop completes during the initial session lookup', async () => {
    const { service, session, repository, runtimeManager } = createStartableLifecycleService();
    let resolveSession!: (value: typeof session) => void;
    repository.getSessionById.mockReturnValueOnce(
      new Promise<typeof session>((resolve) => {
        resolveSession = resolve;
      })
    );

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
    expect(getStopGenerations(service).has('session-1')).toBe(false);
  });

  it('releases the stop generation when startup fails before creating a runtime', async () => {
    const { service, runtimeManager } = createStartableLifecycleService();
    runtimeManager.getOrCreateClient.mockRejectedValueOnce(new Error('spawn failed'));

    await expect(service.startSession('session-1')).rejects.toThrow('spawn failed');

    expect(getStopGenerations(service).has('session-1')).toBe(false);
  });

  it('does not retain a stop generation when client lookup cannot find the session', async () => {
    const { service, repository } = createStartableLifecycleService();
    repository.getSessionById.mockResolvedValueOnce(null);

    await expect(service.getOrCreateSessionClient('missing-session')).rejects.toThrow(
      'Session not found: missing-session'
    );

    expect(getStopGenerations(service).has('missing-session')).toBe(false);
  });

  it('releases the stop generation when record-based client creation fails', async () => {
    const { service, session, runtimeManager } = createStartableLifecycleService();
    runtimeManager.getOrCreateClient.mockRejectedValueOnce(new Error('spawn failed'));

    await expect(service.getOrCreateSessionClientFromRecord(session as never)).rejects.toThrow(
      'spawn failed'
    );

    expect(getStopGenerations(service).has('session-1')).toBe(false);
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
    const { service, runtimeManager } = createStartableLifecycleService();

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
    expect(getStopGenerations(service).has('session-1')).toBe(true);
  });

  it('dispatches queued notifications after startup presets and skips the default continue prompt', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage, sessionConfigService } =
      createStartableLifecycleService({ pendingNotificationCount: 2 });

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
    const { service, sendSessionMessage, tryDispatchNextMessage } = createStartableLifecycleService(
      {
        pendingNotificationCount: 1,
      }
    );

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
    const { service, sendSessionMessage } = createStartableLifecycleService();
    sendSessionMessage.mockReturnValueOnce(pendingPrompt);

    const startResult = service.startSession('session-1').catch((error) => error);
    await vi.waitFor(() => {
      expect(sendSessionMessage).toHaveBeenCalledWith('session-1', 'Continue with the task.');
    });

    await service.stopSession('session-1');
    resolvePrompt(undefined);

    await expect(startResult).resolves.toEqual(
      expect.objectContaining({ message: 'Session is currently being stopped' })
    );
    expect(getStopGenerations(service).has('session-1')).toBe(false);
  });

  it('does not create a client after stop completes during permission resolution', async () => {
    type UserSettings = Awaited<ReturnType<typeof userSettingsService.get>>;
    let resolveSettings!: (settings: UserSettings) => void;
    const pendingSettings = new Promise<UserSettings>((resolve) => {
      resolveSettings = resolve;
    });
    vi.mocked(userSettingsService.get).mockReturnValueOnce(pendingSettings);
    const { service, sendSessionMessage, runtimeManager } = createStartableLifecycleService();

    const startResult = service.startSession('session-1').catch((error) => error);
    await vi.waitFor(() => {
      expect(userSettingsService.get).toHaveBeenCalled();
    });

    await service.stopSession('session-1');
    expect(getStopGenerations(service).has('session-1')).toBe(false);
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
    expect(getStopGenerations(service).has('session-1')).toBe(false);
  });

  it('releases the stop generation after a session stops', async () => {
    const { service } = createStartableLifecycleService();

    await service.stopSession('session-1');

    expect(getStopGenerations(service).has('session-1')).toBe(false);
  });

  it('releases the stop generation when viewers retain inactive session state', async () => {
    const { service, sessionDomainService } = createStartableLifecycleService();
    sessionEventBus.registerViewerCountProvider((sessionId) => (sessionId === 'session-1' ? 1 : 0));

    try {
      await service.stopSession('session-1');
    } finally {
      sessionEventBus.registerViewerCountProvider(null);
    }

    expect(sessionDomainService.clearSession).not.toHaveBeenCalled();
    expect(getStopGenerations(service).has('session-1')).toBe(false);
  });

  it('does not clear a restarted generation when an old runtime exit finishes', async () => {
    const { service, session, repository } = createStartableLifecycleService();
    let resolveUpdate!: (value: typeof session) => void;
    repository.updateSession.mockReturnValueOnce(
      new Promise<typeof session>((resolve) => {
        resolveUpdate = resolve;
      })
    );
    const oldGeneration = service.getStopGeneration('session-1');
    const handlers = (
      service as unknown as {
        setupAcpEventHandler(sessionId: string): {
          onExit(sessionId: string, exitCode: number | null): Promise<void>;
        };
      }
    ).setupAcpEventHandler('session-1');

    const exitPromise = handlers.onExit('session-1', 0);

    expect(getStopGenerations(service).has('session-1')).toBe(false);
    await service.startSession('session-1');
    const restartedGeneration = service.getStopGeneration('session-1');
    expect(restartedGeneration).not.toBe(oldGeneration);

    resolveUpdate(session);
    await exitPromise;

    expect(service.isStopGenerationCurrent('session-1', restartedGeneration)).toBe(true);
    expect(service.isStopGenerationCurrent('session-1', oldGeneration)).toBe(false);
  });

  it('waits for a registered client creation and stops the resulting runtime', async () => {
    const { service, sendSessionMessage, runtimeManager } = createStartableLifecycleService();
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

  it('skips the restart default continue prompt when notifications are queued', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createStartableLifecycleService(
      {
        pendingNotificationCount: 1,
      }
    );

    await service.restartSession('session-1');

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('sends an explicit restart prompt after queued notification dispatch starts', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createStartableLifecycleService(
      {
        pendingNotificationCount: 1,
      }
    );

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

  it('does not fail startup when queued notification dispatch fails', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createStartableLifecycleService(
      {
        pendingNotificationCount: 1,
        tryDispatchNextMessage: () => Promise.reject(new Error('dispatch failed')),
      }
    );

    await expect(service.startSession('session-1')).resolves.toBeUndefined();

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });
});
