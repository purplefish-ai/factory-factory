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

  it('does not let a stale release clear a reclaimed notification for the same session', () => {
    const { service } = createHarness();
    const staleClaim = service.claimForDispatch('session-1', 'workspace-notification-notif-1');
    service.resetSession('session-1');
    expect(service.claimForDispatch('session-1', 'workspace-notification-notif-1')).toMatchObject({
      status: 'claimed',
    });

    if (staleClaim.status !== 'claimed') {
      throw new Error('Expected notification claim');
    }
    staleClaim.release();

    expect(service.claimForDispatch('session-2', 'workspace-notification-notif-1')).toEqual({
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

it('awaits the current destination fence before enqueuing or appending recovered cards', async () => {
  const h = createHarness({ pending: [createPendingWorkspaceNotification()] });
  await h.service.recoverPending({
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    assertAllowed: () => Promise.reject(new Error('Destination changed')),
  });
  expect(h.queuePort.enqueue).not.toHaveBeenCalled();
  expect(h.transcriptPort.appendClaudeEvent).not.toHaveBeenCalled();
});
