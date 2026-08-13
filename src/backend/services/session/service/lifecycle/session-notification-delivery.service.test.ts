import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/shared/acp-protocol';
import {
  type NotificationPersistencePort,
  SessionNotificationDeliveryService,
} from './session-notification-delivery.service';

const { logger } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => logger,
}));

function createPendingWorkspaceNotification(
  overrides: Partial<{
    id: string;
    workspaceId: string;
    sourceWorkspaceId: string;
    sourceWorkspaceName: string;
    sourceProjectName: string;
    message: string;
    direction: 'PARENT_TO_CHILD' | 'CHILD_TO_PARENT';
    deliveredAt: Date | null;
    createdAt: Date;
  }> = {}
) {
  return {
    id: 'notif-parent',
    workspaceId: 'workspace-1',
    sourceWorkspaceId: 'parent-workspace',
    sourceWorkspaceName: 'Parent Workspace',
    sourceProjectName: 'Parent Project',
    message: 'Please check the failing test.',
    direction: 'PARENT_TO_CHILD' as const,
    deliveredAt: null,
    createdAt: new Date('2026-06-22T10:30:00.000Z'),
    ...overrides,
  };
}

type HarnessOptions = {
  pending?: ReturnType<typeof createPendingWorkspaceNotification>[];
  transcript?: ChatMessage[];
  historyHydrationSource?: 'jsonl' | 'acp_fallback' | 'none';
  enqueueResult?: { position: number } | { error: string };
};

function createHarness(options: HarnessOptions = {}) {
  const notificationPort = {
    listPendingForDelivery: vi.fn(async () => options.pending ?? []),
    findForDelivery: vi.fn<NotificationPersistencePort['findForDelivery']>(async () => null),
    markDelivered: vi.fn(async () => undefined),
  };
  const queuePort = {
    hasQueuedMessage: vi.fn(() => false),
    enqueue: vi.fn(() => options.enqueueResult ?? { position: 1 }),
    removeQueuedMessage: vi.fn(() => true),
  };
  const transcriptPort = {
    getTranscriptSnapshot: vi.fn(() => options.transcript ?? []),
    getHistoryHydrationSource: vi.fn(() => options.historyHydrationSource ?? 'none'),
    appendClaudeEvent: vi.fn(() => 7),
  };
  const deltaPort = {
    emitDelta: vi.fn(),
  };
  const service = new SessionNotificationDeliveryService({
    notificationPort,
    queuePort,
    transcriptPort,
    deltaPort,
  });

  return { service, notificationPort, queuePort, transcriptPort, deltaPort };
}

describe('SessionNotificationDeliveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recovers pending parent and child notifications without marking them delivered on enqueue', async () => {
    const createdAt = new Date('2026-06-22T10:30:00.000Z');
    const { service, notificationPort, queuePort, transcriptPort, deltaPort } = createHarness({
      pending: [
        createPendingWorkspaceNotification({ createdAt }),
        createPendingWorkspaceNotification({
          id: 'notif-child',
          sourceWorkspaceId: 'child-workspace',
          sourceWorkspaceName: 'Child Workspace',
          sourceProjectName: 'Child Project',
          message: 'The branch is ready for review.',
          direction: 'CHILD_TO_PARENT',
          createdAt,
        }),
      ],
    });

    const result = await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(result).toEqual({ dispatchableCount: 2 });
    expect(queuePort.enqueue).toHaveBeenNthCalledWith(1, 'session-1', {
      id: 'workspace-notification-notif-parent',
      text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.\n\n<!-- factory-factory-workspace-notification:notif-parent -->',
      timestamp: '2026-06-22T10:30:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    expect(queuePort.enqueue).toHaveBeenNthCalledWith(
      2,
      'session-1',
      expect.objectContaining({
        id: 'workspace-notification-notif-child',
        text: '[Message from child workspace "Child Workspace"]: The branch is ready for review.\n\n<!-- factory-factory-workspace-notification:notif-child -->',
      })
    );
    expect(transcriptPort.appendClaudeEvent).toHaveBeenNthCalledWith(1, 'session-1', {
      type: 'parent_workspace_update',
      parentWorkspaceId: 'parent-workspace',
      parentWorkspaceName: 'Parent Workspace',
      parentProjectName: 'Parent Project',
      text: 'Please check the failing test.',
      timestamp: '2026-06-22T10:30:00.000Z',
    });
    expect(transcriptPort.appendClaudeEvent).toHaveBeenNthCalledWith(2, 'session-1', {
      type: 'child_workspace_update',
      childWorkspaceId: 'child-workspace',
      childWorkspaceName: 'Child Workspace',
      childProjectName: 'Child Project',
      text: 'The branch is ready for review.',
      timestamp: '2026-06-22T10:30:00.000Z',
    });
    expect(deltaPort.emitDelta).toHaveBeenCalledTimes(2);
    expect(deltaPort.emitDelta).toHaveBeenNthCalledWith(1, 'session-1', {
      type: 'agent_message',
      data: expect.objectContaining({ type: 'parent_workspace_update' }),
      order: 7,
    });
    expect(notificationPort.markDelivered).not.toHaveBeenCalled();
  });

  it('checks startup eligibility after pending reads and before each enqueue', async () => {
    const { service, queuePort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
    });
    const assertAllowed = vi.fn(() => {
      throw new Error('Session is currently being stopped');
    });

    await expect(
      service.recoverPending({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        assertAllowed,
      })
    ).resolves.toEqual({ dispatchableCount: 0 });

    expect(assertAllowed).toHaveBeenCalledOnce();
    expect(queuePort.enqueue).not.toHaveBeenCalled();
  });

  it('leaves notifications pending and omits UI cards when enqueue fails', async () => {
    const { service, notificationPort, queuePort, transcriptPort, deltaPort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
      enqueueResult: { error: 'Queue full' },
    });

    const result = await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(result).toEqual({ dispatchableCount: 0 });
    expect(queuePort.enqueue).toHaveBeenCalledOnce();
    expect(transcriptPort.appendClaudeEvent).not.toHaveBeenCalled();
    expect(deltaPort.emitDelta).not.toHaveBeenCalled();
    expect(notificationPort.markDelivered).not.toHaveBeenCalled();
  });

  it('reports an already-queued pending notification as dispatchable without enqueueing it', async () => {
    const { service, notificationPort, queuePort, transcriptPort, deltaPort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
    });
    queuePort.hasQueuedMessage.mockReturnValue(true);

    const result = await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(result).toEqual({ dispatchableCount: 1 });
    expect(queuePort.enqueue).not.toHaveBeenCalled();
    expect(transcriptPort.appendClaudeEvent).not.toHaveBeenCalled();
    expect(deltaPort.emitDelta).not.toHaveBeenCalled();
    expect(notificationPort.markDelivered).not.toHaveBeenCalled();
  });

  it('does not re-enqueue a notification queued during transcript reconciliation', async () => {
    const { service, queuePort, transcriptPort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
    });
    let queuedByLiveDelivery = false;
    queuePort.hasQueuedMessage.mockImplementation(() => queuedByLiveDelivery);
    transcriptPort.getTranscriptSnapshot.mockImplementation(() => {
      queuedByLiveDelivery = true;
      return [];
    });

    const result = await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(result).toEqual({ dispatchableCount: 1 });
    expect(queuePort.hasQueuedMessage).toHaveBeenCalledTimes(2);
    expect(queuePort.enqueue).not.toHaveBeenCalled();
    expect(transcriptPort.appendClaudeEvent).not.toHaveBeenCalled();
  });

  it('marks an exact-ID committed user notification delivered without requeueing it', async () => {
    const { service, notificationPort, queuePort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
      transcript: [
        {
          id: 'workspace-notification-notif-parent',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.',
          timestamp: '2026-06-22T10:30:00.000Z',
          order: 1,
        },
      ],
    });

    const result = await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(result).toEqual({ dispatchableCount: 0 });
    expect(queuePort.enqueue).not.toHaveBeenCalled();
    expect(notificationPort.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });

  it('matches JSONL notification evidence with a provider-generated transcript ID', async () => {
    const { service, notificationPort, queuePort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
      historyHydrationSource: 'jsonl',
      transcript: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000-0',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.\n\n<!-- factory-factory-workspace-notification:notif-parent -->',
          timestamp: '2026-06-22T10:30:00.000Z',
          order: 0,
        },
      ],
    });

    await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(queuePort.enqueue).not.toHaveBeenCalled();
    expect(notificationPort.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });

  it('does not content-match identical user text without the notification marker', async () => {
    const { service, notificationPort, queuePort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
      historyHydrationSource: 'jsonl',
      transcript: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000-0',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.',
          timestamp: '2026-06-22T10:30:00.000Z',
          order: 0,
        },
      ],
    });

    await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(queuePort.enqueue).toHaveBeenCalledOnce();
    expect(notificationPort.markDelivered).not.toHaveBeenCalled();
  });

  it('consumes one provider-generated transcript entry once for duplicate pending content', async () => {
    const { service, notificationPort, queuePort } = createHarness({
      pending: [
        createPendingWorkspaceNotification({ id: 'notif-parent-oldest' }),
        createPendingWorkspaceNotification({
          id: 'notif-parent-newest',
          createdAt: new Date('2026-06-22T10:31:00.000Z'),
        }),
      ],
      historyHydrationSource: 'jsonl',
      transcript: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000-0',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.\n\n<!-- factory-factory-workspace-notification:notif-parent-oldest -->',
          timestamp: '2026-06-22T10:30:00.000Z',
          order: 0,
        },
      ],
    });

    await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(queuePort.enqueue).toHaveBeenCalledOnce();
    expect(queuePort.enqueue).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'workspace-notification-notif-parent-newest' })
    );
    expect(notificationPort.markDelivered).toHaveBeenCalledTimes(1);
    expect(notificationPort.markDelivered).toHaveBeenCalledWith(['notif-parent-oldest']);
  });

  it("does not let older duplicate content consume a later notification's exact-ID evidence", async () => {
    const { service, notificationPort, queuePort } = createHarness({
      pending: [
        createPendingWorkspaceNotification({ id: 'notif-parent-A' }),
        createPendingWorkspaceNotification({
          id: 'notif-parent-B',
          createdAt: new Date('2026-06-22T10:31:00.000Z'),
        }),
      ],
      historyHydrationSource: 'jsonl',
      transcript: [
        {
          id: 'workspace-notification-notif-parent-B',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.',
          timestamp: '2026-06-22T10:31:00.000Z',
          order: 0,
        },
      ],
    });

    await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(queuePort.enqueue).toHaveBeenCalledOnce();
    expect(queuePort.enqueue).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'workspace-notification-notif-parent-A' })
    );
    expect(notificationPort.markDelivered).toHaveBeenCalledWith(['notif-parent-B']);
  });

  it('does not content-match canonical text from non-JSONL history', async () => {
    const { service, notificationPort, queuePort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
      historyHydrationSource: 'acp_fallback',
      transcript: [
        {
          id: 'session-1-42',
          source: 'user',
          text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.\n\n<!-- factory-factory-workspace-notification:notif-parent -->',
          timestamp: '2026-06-22T10:30:00.000Z',
          order: 0,
        },
      ],
    });

    await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(queuePort.enqueue).toHaveBeenCalledOnce();
    expect(notificationPort.markDelivered).not.toHaveBeenCalled();
  });

  it('does not requeue transcript evidence when best-effort delivery marking fails', async () => {
    const { service, notificationPort, queuePort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
      transcript: [
        {
          id: 'workspace-notification-notif-parent',
          source: 'user',
          text: 'committed notification',
          timestamp: '2026-06-22T10:30:00.000Z',
          order: 1,
        },
      ],
    });
    notificationPort.markDelivered.mockRejectedValue(new Error('database unavailable'));

    await expect(
      service.recoverPending({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        assertAllowed: vi.fn(),
      })
    ).resolves.toEqual({ dispatchableCount: 0 });

    expect(queuePort.enqueue).not.toHaveBeenCalled();
    expect(notificationPort.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });

  it('does not treat UI-only workspace update cards as transcript delivery evidence', async () => {
    const { service, notificationPort, queuePort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
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
            timestamp: '2026-06-22T10:30:00.000Z',
          },
          timestamp: '2026-06-22T10:30:00.000Z',
          order: 1,
        },
      ],
    });

    await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(queuePort.enqueue).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'workspace-notification-notif-parent' })
    );
    expect(notificationPort.markDelivered).not.toHaveBeenCalled();
  });

  it('does not duplicate queue or UI work during repeated recovery', async () => {
    const { service, notificationPort, queuePort, transcriptPort } = createHarness({
      pending: [createPendingWorkspaceNotification()],
    });
    queuePort.hasQueuedMessage.mockImplementation(() => queuePort.enqueue.mock.calls.length > 0);

    const first = await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });
    const second = await service.recoverPending({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      assertAllowed: vi.fn(),
    });

    expect(first).toEqual({ dispatchableCount: 1 });
    expect(second).toEqual({ dispatchableCount: 1 });
    expect(notificationPort.listPendingForDelivery).toHaveBeenCalledTimes(2);
    expect(queuePort.enqueue).toHaveBeenCalledOnce();
    expect(transcriptPort.appendClaudeEvent).toHaveBeenCalledOnce();
  });

  it('claims notification dispatch once and releases it for another session', () => {
    const { service } = createHarness();

    expect(service.claimForDispatch('session-1', 'regular-message')).toEqual({
      status: 'not_notification',
    });
    const firstClaim = service.claimForDispatch('session-1', 'workspace-notification-notif-1');
    expect(firstClaim).toMatchObject({ status: 'claimed', notificationId: 'notif-1' });
    expect(service.claimForDispatch('session-2', 'workspace-notification-notif-1')).toEqual({
      status: 'duplicate',
    });

    if (firstClaim.status !== 'claimed') {
      throw new Error('Expected notification claim');
    }
    firstClaim.release();

    expect(service.claimForDispatch('session-2', 'workspace-notification-notif-1')).toMatchObject({
      status: 'claimed',
      notificationId: 'notif-1',
    });
  });

  it('treats exact committed user-message evidence as a duplicate dispatch', () => {
    const { service } = createHarness({
      transcript: [
        {
          id: 'workspace-notification-notif-1',
          source: 'user',
          text: 'already committed',
          timestamp: '2026-06-22T10:30:00.000Z',
          order: 1,
        },
      ],
    });

    expect(service.claimForDispatch('session-1', 'workspace-notification-notif-1')).toEqual({
      status: 'duplicate',
    });
  });

  it('transfers a claim after the owning session resets', () => {
    const { service } = createHarness();
    expect(service.claimForDispatch('session-1', 'workspace-notification-notif-1')).toMatchObject({
      status: 'claimed',
    });

    service.resetSession('session-1');

    expect(service.claimForDispatch('session-2', 'workspace-notification-notif-1')).toMatchObject({
      status: 'claimed',
      notificationId: 'notif-1',
    });
  });

  it('does not let a stale release clear a transferred claim', () => {
    const { service } = createHarness();
    const staleClaim = service.claimForDispatch('session-1', 'workspace-notification-notif-1');
    service.resetSession('session-1');
    expect(service.claimForDispatch('session-2', 'workspace-notification-notif-1')).toMatchObject({
      status: 'claimed',
    });

    if (staleClaim.status !== 'claimed') {
      throw new Error('Expected notification claim');
    }
    staleClaim.release();

    expect(service.claimForDispatch('session-3', 'workspace-notification-notif-1')).toEqual({
      status: 'duplicate',
    });
  });

  it('reports delivered rows and pending rows through the durable notification port', async () => {
    const { service, notificationPort } = createHarness();
    notificationPort.findForDelivery
      .mockResolvedValueOnce({ deliveredAt: new Date('2026-06-22T10:30:00.000Z') })
      .mockResolvedValueOnce({ deliveredAt: null })
      .mockResolvedValueOnce(null);

    await expect(service.isAlreadyDelivered('notif-delivered')).resolves.toBe(true);
    await expect(service.isAlreadyDelivered('notif-pending')).resolves.toBe(false);
    await expect(service.isAlreadyDelivered('notif-missing')).resolves.toBe(false);
  });

  it('fails open when durable notification delivery state cannot be read', async () => {
    const { service, notificationPort } = createHarness();
    notificationPort.findForDelivery.mockRejectedValue(new Error('database unavailable'));

    await expect(service.isAlreadyDelivered('notif-1')).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      '[Chat WS] Failed to check workspace notification delivery state',
      expect.objectContaining({ notificationId: 'notif-1', error: 'database unavailable' })
    );
  });

  it('removes duplicate notification cards through the queue port', () => {
    const { service, queuePort } = createHarness();
    queuePort.removeQueuedMessage.mockReturnValue(false);

    expect(service.removeDuplicateFromQueue('session-1', 'workspace-notification-notif-1')).toBe(
      false
    );
    expect(queuePort.removeQueuedMessage).toHaveBeenCalledWith(
      'session-1',
      'workspace-notification-notif-1'
    );
  });

  it('marks delivered only after successful provider dispatch acknowledgement', async () => {
    const { service, notificationPort } = createHarness();

    await service.acknowledgeSuccessfulDispatch('workspace-notification-notif-1');

    expect(notificationPort.markDelivered).toHaveBeenCalledWith(['notif-1']);
  });

  it('ignores acknowledgement for generic and malformed notification message IDs', async () => {
    const { service, notificationPort } = createHarness();

    await service.acknowledgeSuccessfulDispatch('regular-message');
    await service.acknowledgeSuccessfulDispatch('workspace-notification-');

    expect(notificationPort.markDelivered).not.toHaveBeenCalled();
    expect(service.isNotificationMessage('regular-message')).toBe(false);
    expect(service.isNotificationMessage('workspace-notification-')).toBe(false);
    expect(service.isNotificationMessage('workspace-notification-notif-1')).toBe(true);
  });

  it('keeps successful provider dispatch acknowledgement best effort when persistence fails', async () => {
    const { service, notificationPort } = createHarness();
    notificationPort.markDelivered.mockRejectedValue(new Error('database unavailable'));

    await expect(
      service.acknowledgeSuccessfulDispatch('workspace-notification-notif-1')
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      '[Chat WS] Failed to mark workspace notification delivered',
      expect.objectContaining({
        messageId: 'workspace-notification-notif-1',
        notificationId: 'notif-1',
        error: 'database unavailable',
      })
    );
  });
});
