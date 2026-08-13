import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceNotificationService } from '@/backend/services/workspace';
import { SessionStatus } from '@/shared/core';
import {
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

describe('SessionNotificationDeliveryService', () => {
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
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleHarness();

    await service.getOrCreateSessionClient('session-1');

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
    expect(sessionDomainService.enqueue).toHaveBeenCalledTimes(2);
    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sessionDomainService.enqueue.mock.invocationCallOrder.at(-1)).toBeLessThan(
      tryDispatchNextMessage.mock.invocationCallOrder[0]!
    );
    expect(workspaceNotificationService.markDelivered).not.toHaveBeenCalled();
  });

  it('does not enqueue notifications found after the startup stop generation changes', async () => {
    let resolvePending!: (notifications: unknown[]) => void;
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockReturnValue(
      new Promise((resolve) => {
        resolvePending = resolve;
      }) as never
    );
    const { service, repository, sessionDomainService } = createLifecycleHarness();

    const startupPromise = service.getOrCreateSessionClient('session-1');
    await vi.waitFor(() => {
      expect(workspaceNotificationService.listPendingForDelivery).toHaveBeenCalledWith(
        'workspace-1'
      );
    });

    await service.stopSession('session-1');
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

    await expect(startupPromise).rejects.toThrow('Session is currently being stopped');
    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'agent_message' })
    );
    expect(repository.updateSession).not.toHaveBeenCalledWith('session-1', {
      status: SessionStatus.RUNNING,
    });
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
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleHarness({
      enqueue: vi.fn(() => ({ error: 'Queue full' })),
    });

    await service.getOrCreateSessionClient('session-1');

    expect(sessionDomainService.enqueue).toHaveBeenCalledTimes(1);
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'agent_message' })
    );
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
    expect(workspaceNotificationService.markDelivered).not.toHaveBeenCalled();
  });

  it('queues recovered notifications before startup dispatch', async () => {
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
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleHarness();

    await service.getOrCreateSessionClient('session-1');

    expect(sessionDomainService.enqueue).toHaveBeenCalledTimes(1);
    expect(sessionDomainService.enqueue).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        id: 'workspace-notification-notif-parent',
      })
    );
    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sessionDomainService.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      tryDispatchNextMessage.mock.invocationCallOrder[0]!
    );
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
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleHarness();
    sessionDomainService.hasQueuedMessage.mockReturnValue(true);

    await service.getOrCreateSessionClient('session-1');

    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'agent_message' })
    );
    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
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
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleHarness();
    let queuedByLiveDelivery = false;
    sessionDomainService.hasQueuedMessage.mockImplementation(() => queuedByLiveDelivery);
    sessionDomainService.getTranscriptSnapshot.mockImplementation(() => {
      queuedByLiveDelivery = true;
      return [];
    });

    await service.getOrCreateSessionClient('session-1');

    expect(sessionDomainService.hasQueuedMessage).toHaveBeenCalledTimes(2);
    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'agent_message' })
    );
    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
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
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleHarness({
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

    await service.getOrCreateSessionClient('session-1');

    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'agent_message' })
    );
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
    const { service, sessionDomainService } = createLifecycleHarness({
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

    await service.getOrCreateSessionClient('session-1');

    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'agent_message' })
    );
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
    const { service, sessionDomainService } = createLifecycleHarness({
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

    await service.getOrCreateSessionClient('session-1');

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
    const { service, sessionDomainService } = createLifecycleHarness({
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

    await service.getOrCreateSessionClient('session-1');

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
    const { service, sessionDomainService } = createLifecycleHarness({
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

    await service.getOrCreateSessionClient('session-1');

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
    const { service, sessionDomainService } = createLifecycleHarness({
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

    await service.getOrCreateSessionClient('session-1');

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
    const { service, sessionDomainService } = createLifecycleHarness({
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

    await service.getOrCreateSessionClient('session-1');

    expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    expect(sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(sessionDomainService.emitDelta).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'agent_message' })
    );
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
    const { service, sessionDomainService } = createLifecycleHarness({
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

    await service.getOrCreateSessionClient('session-1');

    expect(sessionDomainService.enqueue).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        id: 'workspace-notification-notif-parent',
      })
    );
    expect(workspaceNotificationService.markDelivered).not.toHaveBeenCalled();
  });

  it('does not duplicate queued work during repeated notification recovery', async () => {
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      createPendingWorkspaceNotification(),
    ] as never);
    const { service, sessionDomainService, tryDispatchNextMessage } = createLifecycleHarness();
    sessionDomainService.hasQueuedMessage.mockImplementation(
      () => sessionDomainService.enqueue.mock.calls.length > 0
    );

    await service.getOrCreateSessionClient('session-1');
    await service.getOrCreateSessionClient('session-1');

    expect(workspaceNotificationService.listPendingForDelivery).toHaveBeenCalledTimes(2);
    expect(sessionDomainService.enqueue).toHaveBeenCalledTimes(1);
    expect(sessionDomainService.appendClaudeEvent).toHaveBeenCalledTimes(1);
    expect(tryDispatchNextMessage).toHaveBeenCalledTimes(2);
  });
});
