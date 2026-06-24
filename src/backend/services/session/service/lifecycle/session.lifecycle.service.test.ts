import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { workspaceNotificationAccessor } from '@/backend/services/workspace';
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

function createLifecycleService(options?: {
  enqueue?: SessionDomainService['enqueue'];
  tryDispatchNextMessage?: (sessionId: string) => Promise<void>;
}) {
  const sessionDomainService = {
    appendClaudeEvent: vi.fn((_sessionId: string, _message: unknown) => 1),
    emitDelta: vi.fn(),
    enqueue:
      options?.enqueue ??
      vi.fn((_sessionId: string, _message: unknown) => ({ position: 0 }) as const),
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
  await (
    service as unknown as {
      deliverPendingChildNotifications(sessionId: string, workspaceId: string): Promise<void>;
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

    await deliverPendingChildNotifications(service);

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
    expect(tryDispatchNextMessage).toHaveBeenCalledTimes(2);
    expect(tryDispatchNextMessage).toHaveBeenNthCalledWith(1, 'session-1');
    expect(tryDispatchNextMessage).toHaveBeenNthCalledWith(2, 'session-1');
    expect(workspaceNotificationAccessor.markDelivered).toHaveBeenCalledWith([
      'notif-parent',
      'notif-child',
    ]);
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
    const { service, tryDispatchNextMessage } = createLifecycleService({
      enqueue: vi.fn(() => ({ error: 'Queue full' })),
    });

    await deliverPendingChildNotifications(service);

    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
    expect(workspaceNotificationAccessor.markDelivered).toHaveBeenCalledWith([]);
  });
});
