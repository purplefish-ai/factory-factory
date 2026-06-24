import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { workspaceNotificationAccessor } from '@/backend/services/workspace';
import type { ChatMessage } from '@/shared/acp-protocol';
import { SessionLifecycleService } from './session.lifecycle.service';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceAccessor: { findById: vi.fn() },
  workspaceNotificationAccessor: {
    findPending: vi.fn(),
    markDelivered: vi.fn(),
  },
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsAccessor: {
    get: vi.fn(async () => ({
      defaultWorkspacePermissions: 'STRICT',
      ratchetPermissions: 'YOLO',
    })),
  },
}));

function createLifecycleService(options?: {
  enqueue?: SessionDomainService['enqueue'];
  transcript?: ChatMessage[];
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
  };
  const tryDispatchNextMessage = options?.tryDispatchNextMessage ?? vi.fn(async () => undefined);

  const service = new SessionLifecycleService({
    repository: {} as never,
    promptBuilder: {} as never,
    runtimeManager: {} as never,
    sessionDomainService: sessionDomainService as unknown as SessionDomainService,
    sessionPermissionService: {} as never,
    sessionConfigService: {} as never,
    acpEventProcessor: {} as never,
    promptTurnCompletionService: {} as never,
    retryService: {} as never,
  });
  service.configure({
    workspace: {
      markSessionRunning: vi.fn(),
      markSessionIdle: vi.fn(),
      clearRatchetActiveSessionIfMatching: vi.fn(async () => undefined),
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

describe('SessionLifecycleService pending workspace notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds pending workspace notifications to the UI transcript and ACP dispatch queue', async () => {
    const createdAt = new Date('2026-06-22T10:30:00.000Z');
    vi.mocked(workspaceNotificationAccessor.findPending).mockResolvedValue([
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
    vi.mocked(workspaceNotificationAccessor.markDelivered).mockResolvedValue();
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
        text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.',
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
        text: '[Message from child workspace "Child Workspace"]: The branch is ready for review.',
      })
    );
    expect(enqueuedCount).toBe(2);
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
    expect(workspaceNotificationAccessor.markDelivered).not.toHaveBeenCalled();
  });

  it('leaves notifications pending when enqueue fails', async () => {
    vi.mocked(workspaceNotificationAccessor.findPending).mockResolvedValue([
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
    expect(workspaceNotificationAccessor.markDelivered).not.toHaveBeenCalled();
  });

  it('does not dispatch pending notifications ahead of an existing queued message', async () => {
    vi.mocked(workspaceNotificationAccessor.findPending).mockResolvedValue([
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
    vi.mocked(workspaceNotificationAccessor.markDelivered).mockResolvedValue();
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
    expect(workspaceNotificationAccessor.markDelivered).not.toHaveBeenCalled();
  });

  it('reports a pending workspace notification that is already queued as dispatchable', async () => {
    vi.mocked(workspaceNotificationAccessor.findPending).mockResolvedValue([
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
    expect(workspaceNotificationAccessor.markDelivered).not.toHaveBeenCalled();
  });

  it('marks an already-committed pending notification delivered without requeueing it', async () => {
    const createdAt = new Date('2026-06-22T10:30:00.000Z');
    vi.mocked(workspaceNotificationAccessor.findPending).mockResolvedValue([
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
    vi.mocked(workspaceNotificationAccessor.markDelivered).mockResolvedValue();
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
    expect(workspaceNotificationAccessor.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });
});

function createStartableLifecycleService(options?: {
  pendingNotificationCount?: number;
  tryDispatchNextMessage?: () => Promise<void>;
}) {
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workflow: 'code',
    provider: 'CLAUDE',
    providerSessionId: null,
    providerMetadata: null,
    model: 'claude-sonnet',
  };
  const workspace = {
    id: 'workspace-1',
    name: 'Workspace',
    description: null,
    projectId: 'project-1',
    worktreePath: '/tmp/workspace',
    branchName: 'feature/test',
    isAutoGeneratedBranch: false,
    hasHadSessions: false,
    runScriptPort: null,
    parentWorkspaceId: null,
    creationMetadata: null,
  };
  const handle = {
    provider: 'CLAUDE',
    providerSessionId: 'provider-session-1',
    configOptions: [],
    isPromptInFlight: false,
  };
  const repository = {
    getSessionById: vi.fn(async () => session),
    getWorkspaceById: vi.fn(async () => workspace),
    getProjectById: vi.fn(),
    markWorkspaceHasHadSessions: vi.fn(async () => undefined),
    updateSession: vi.fn(async () => undefined),
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
    getClient: vi.fn(() => undefined),
    getOrCreateClient: vi.fn(async () => handle),
  };
  const sessionDomainService = {
    setRuntimeSnapshot: vi.fn(),
    emitDelta: vi.fn(),
    isHistoryHydrated: vi.fn(() => false),
    getTranscriptSnapshot: vi.fn(() => []),
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
  };
  const tryDispatchNextMessage = vi.fn(options?.tryDispatchNextMessage ?? (async () => undefined));
  const sendSessionMessage = vi.fn(async () => undefined);

  const service = new SessionLifecycleService({
    repository: repository as never,
    promptBuilder: promptBuilder as never,
    runtimeManager: runtimeManager as never,
    sessionDomainService: sessionDomainService as never,
    sessionPermissionService: {} as never,
    sessionConfigService: sessionConfigService as never,
    acpEventProcessor: acpEventProcessor as never,
    promptTurnCompletionService: {} as never,
    retryService: {} as never,
  });
  service.configure({
    workspace: {
      markSessionRunning: vi.fn(),
      markSessionIdle: vi.fn(),
      clearRatchetActiveSessionIfMatching: vi.fn(async () => undefined),
    },
    messageQueue: { tryDispatchNextMessage },
  });
  (
    service as unknown as {
      deliverPendingChildNotifications(sessionId: string, workspaceId: string): Promise<number>;
    }
  ).deliverPendingChildNotifications = vi.fn(async () => options?.pendingNotificationCount ?? 0);

  return {
    service,
    sendSessionMessage,
    tryDispatchNextMessage,
    sessionConfigService,
  };
}

describe('SessionLifecycleService startSession pending workspace notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches queued notifications after startup presets and skips the default continue prompt', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage, sessionConfigService } =
      createStartableLifecycleService({ pendingNotificationCount: 2 });

    await service.startSession('session-1', sendSessionMessage);

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

    await service.startSession('session-1', sendSessionMessage, { initialPrompt: 'Follow up' });

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).toHaveBeenCalledWith('session-1', 'Follow up');
    const dispatchOrder = tryDispatchNextMessage.mock.invocationCallOrder[0];
    const sendOrder = sendSessionMessage.mock.invocationCallOrder[0];
    expect(dispatchOrder).toBeDefined();
    expect(sendOrder).toBeDefined();
    expect(dispatchOrder!).toBeLessThan(sendOrder!);
  });

  it('skips the restart default continue prompt when notifications are queued', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createStartableLifecycleService(
      {
        pendingNotificationCount: 1,
      }
    );

    await service.restartSession('session-1', sendSessionMessage);

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('does not fail startup when queued notification dispatch fails', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createStartableLifecycleService(
      {
        pendingNotificationCount: 1,
        tryDispatchNextMessage: () => Promise.reject(new Error('dispatch failed')),
      }
    );

    await expect(service.startSession('session-1', sendSessionMessage)).resolves.toBeUndefined();

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });
});
