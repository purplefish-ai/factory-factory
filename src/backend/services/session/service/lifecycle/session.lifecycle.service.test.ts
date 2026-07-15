import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { userSettingsAccessor } from '@/backend/services/settings';
import { workspaceNotificationAccessor } from '@/backend/services/workspace';
import type { ChatMessage } from '@/shared/acp-protocol';
import { SessionStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
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
  });
  service.configure({
    workspace: {
      markSessionRunning: vi.fn(),
      markSessionIdle: vi.fn(),
      recordRatchetSessionEnd: vi.fn(async () => undefined),
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

function createStoppableLifecycleService() {
  const repository = {
    getSessionsByWorkspaceId: vi.fn(async () => [
      { id: 'session-running', status: SessionStatus.RUNNING },
      { id: 'session-runtime-only', status: SessionStatus.COMPLETED },
      { id: 'session-idle', status: SessionStatus.IDLE },
    ]),
  };
  const runtimeManager = {
    isSessionRunning: vi.fn((sessionId: string) => sessionId === 'session-runtime-only'),
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
  });
  const stopSession = vi.fn((_sessionId: string): Promise<void> => Promise.resolve());
  (service as unknown as { stopSession: typeof stopSession }).stopSession = stopSession;

  return { service, repository, runtimeManager, stopSession };
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
    expect(stopSession).toHaveBeenCalledWith('session-running');
    expect(stopSession).toHaveBeenCalledWith('session-runtime-only');
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
    expect(stopSession).toHaveBeenCalledWith('session-running');
    expect(stopSession).toHaveBeenCalledWith('session-runtime-only');
  });
});

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
    expect(workspaceNotificationAccessor.markDelivered).not.toHaveBeenCalled();
  });

  it('does not enqueue notifications found after the startup stop generation changes', async () => {
    let resolvePending!: (notifications: unknown[]) => void;
    vi.mocked(workspaceNotificationAccessor.findPending).mockReturnValue(
      new Promise((resolve) => {
        resolvePending = resolve;
      }) as never
    );
    const { service, sessionDomainService } = createLifecycleService();

    const deliveryPromise = deliverPendingChildNotifications(service);
    await vi.waitFor(() => {
      expect(workspaceNotificationAccessor.findPending).toHaveBeenCalledWith('workspace-1');
    });

    (
      service as unknown as {
        stopGenerations: Map<string, number>;
      }
    ).stopGenerations.set('session-1', 1);
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

  it('matches an already-committed pending notification with a provider-generated ID', async () => {
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
    expect(workspaceNotificationAccessor.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });

  it('does not match identical user text without a notification marker', async () => {
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
    expect(workspaceNotificationAccessor.markDelivered).not.toHaveBeenCalled();
  });

  it('consumes one provider-generated transcript entry once for duplicate pending notifications', async () => {
    const oldestCreatedAt = new Date('2026-06-22T10:30:00.000Z');
    const newestCreatedAt = new Date('2026-06-22T10:31:00.000Z');
    vi.mocked(workspaceNotificationAccessor.findPending).mockResolvedValue([
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
    vi.mocked(workspaceNotificationAccessor.markDelivered).mockResolvedValue();
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
    expect(workspaceNotificationAccessor.markDelivered).toHaveBeenCalledTimes(1);
    expect(workspaceNotificationAccessor.markDelivered).toHaveBeenCalledWith([
      'notif-parent-oldest',
    ]);
  });

  it("does not let an older duplicate consume a later notification's exact transcript entry", async () => {
    const oldestCreatedAt = new Date('2026-06-22T10:30:00.000Z');
    const newestCreatedAt = new Date('2026-06-22T10:31:00.000Z');
    vi.mocked(workspaceNotificationAccessor.findPending).mockResolvedValue([
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
    vi.mocked(workspaceNotificationAccessor.markDelivered).mockResolvedValue();
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
    expect(workspaceNotificationAccessor.markDelivered).toHaveBeenCalledTimes(1);
    expect(workspaceNotificationAccessor.markDelivered).toHaveBeenCalledWith(['notif-parent-B']);
  });

  it('does not content-match a normal live user entry with canonical notification text', async () => {
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
    expect(workspaceNotificationAccessor.markDelivered).not.toHaveBeenCalled();
  });

  it('does not requeue an already-committed pending notification when delivery retry fails', async () => {
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
    vi.mocked(workspaceNotificationAccessor.markDelivered).mockRejectedValue(
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
    expect(workspaceNotificationAccessor.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });

  it('does not treat UI-only workspace update cards as delivered user messages', async () => {
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
    expect(workspaceNotificationAccessor.markDelivered).not.toHaveBeenCalled();
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
    getClient: vi.fn(() => undefined),
    getOrCreateClient: vi.fn(async () => handle),
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
  });
  service.configure({
    workspace: {
      markSessionRunning: vi.fn(),
      markSessionIdle: vi.fn(),
      recordRatchetSessionEnd: vi.fn(async () => undefined),
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
    runtimeManager,
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

  it('does not create a client after stop completes during permission resolution', async () => {
    type UserSettings = Awaited<ReturnType<typeof userSettingsAccessor.get>>;
    let resolveSettings!: (settings: UserSettings) => void;
    const pendingSettings = new Promise<UserSettings>((resolve) => {
      resolveSettings = resolve;
    });
    vi.mocked(userSettingsAccessor.get).mockReturnValueOnce(pendingSettings);
    const { service, sendSessionMessage, runtimeManager } = createStartableLifecycleService();

    const startResult = service
      .startSession('session-1', sendSessionMessage)
      .catch((error) => error);
    await vi.waitFor(() => {
      expect(userSettingsAccessor.get).toHaveBeenCalled();
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
  });

  it('waits for a registered client creation and stops the resulting runtime', async () => {
    const { service, sendSessionMessage, runtimeManager } = createStartableLifecycleService();
    type RuntimeHandle = Awaited<ReturnType<typeof runtimeManager.getOrCreateClient>>;
    let resolveClient!: (handle: RuntimeHandle) => void;
    const pendingClient = new Promise<RuntimeHandle>((resolve) => {
      resolveClient = resolve;
    });
    runtimeManager.getOrCreateClient.mockReturnValueOnce(pendingClient);

    const startResult = service
      .startSession('session-1', sendSessionMessage)
      .catch((error) => error);
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

    await service.restartSession('session-1', sendSessionMessage);

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('sends an explicit restart prompt after queued notification dispatch starts', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createStartableLifecycleService(
      {
        pendingNotificationCount: 1,
      }
    );

    await service.restartSession('session-1', sendSessionMessage, {
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

    await expect(service.startSession('session-1', sendSessionMessage)).resolves.toBeUndefined();

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });
});
