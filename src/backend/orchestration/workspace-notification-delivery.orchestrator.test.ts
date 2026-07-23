import type { WorkspaceNotification } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/shared/acp-protocol';

const mockFindSessionsByWorkspaceId = vi.hoisted(() => vi.fn());
const mockAppendClaudeEvent = vi.hoisted(() => vi.fn());
const mockEmitDelta = vi.hoisted(() => vi.fn());
const mockEnqueue = vi.hoisted(() => vi.fn());
const mockHasQueuedMessage = vi.hoisted(() => vi.fn());
const mockTryDispatchNextMessage = vi.hoisted(() => vi.fn());
const mockPersistChildNotification = vi.hoisted(() => vi.fn());
const mockPersistParentNotification = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/session', () => ({
  chatMessageHandlerService: {
    tryDispatchNextMessage: (...args: unknown[]) => mockTryDispatchNextMessage(...args),
  },
  sessionDataService: {
    findAgentSessionsByWorkspaceId: (...args: unknown[]) => mockFindSessionsByWorkspaceId(...args),
  },
  sessionDomainService: {
    appendClaudeEvent: (...args: unknown[]) => mockAppendClaudeEvent(...args),
    emitDelta: (...args: unknown[]) => mockEmitDelta(...args),
    enqueue: (...args: unknown[]) => mockEnqueue(...args),
    hasQueuedMessage: (...args: unknown[]) => mockHasQueuedMessage(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ warn: (...args: unknown[]) => mockWarn(...args) }),
}));

vi.mock('./workspace-children.orchestrator', () => ({
  persistChildNotification: (...args: unknown[]) => mockPersistChildNotification(...args),
  persistParentNotification: (...args: unknown[]) => mockPersistParentNotification(...args),
}));

import {
  type DeliverWorkspaceNotificationInput,
  deliverWorkspaceNotification,
} from './workspace-notification-delivery.orchestrator';

type DeliveryCase = {
  name: string;
  input: DeliverWorkspaceNotificationInput;
  notification: WorkspaceNotification;
  expectedPersistenceInput: Record<string, string>;
  expectedQueueText: string;
  expectedUiEvent: AgentMessage;
};

const childNotification: WorkspaceNotification = {
  id: 'notification-child',
  workspaceId: 'parent-1',
  sourceWorkspaceId: 'child-1',
  sourceWorkspaceName: 'Child WS',
  sourceProjectName: 'Child Project',
  message: 'hello parent',
  direction: 'CHILD_TO_PARENT',
  deliveredAt: null,
  createdAt: new Date('2026-07-17T12:00:00.000Z'),
};

const parentNotification: WorkspaceNotification = {
  id: 'notification-parent',
  workspaceId: 'child-1',
  sourceWorkspaceId: 'parent-1',
  sourceWorkspaceName: 'Parent WS',
  sourceProjectName: 'Parent Project',
  message: 'hello child',
  direction: 'PARENT_TO_CHILD',
  deliveredAt: null,
  createdAt: new Date('2026-07-17T12:00:01.000Z'),
};

const deliveryCases: DeliveryCase[] = [
  {
    name: 'child to parent',
    input: {
      direction: 'CHILD_TO_PARENT',
      targetWorkspaceId: 'parent-1',
      sourceWorkspace: {
        id: 'child-1',
        name: 'Child WS',
        projectName: 'Child Project',
      },
      message: 'hello parent',
      buildUiEvent: ({ sourceWorkspace, message, timestamp }) => ({
        type: 'child_workspace_update',
        childWorkspaceId: sourceWorkspace.id,
        childWorkspaceName: sourceWorkspace.name,
        childProjectName: sourceWorkspace.projectName,
        text: message,
        timestamp,
      }),
    },
    notification: childNotification,
    expectedPersistenceInput: {
      parentWorkspaceId: 'parent-1',
      sourceWorkspaceId: 'child-1',
      message: 'hello parent',
    },
    expectedQueueText:
      '[Message from child workspace "Child WS"]: hello parent\n\n<!-- factory-factory-workspace-notification:notification-child -->',
    expectedUiEvent: {
      type: 'child_workspace_update',
      childWorkspaceId: 'child-1',
      childWorkspaceName: 'Child WS',
      childProjectName: 'Child Project',
      text: 'hello parent',
      timestamp: expect.any(String),
    },
  },
  {
    name: 'parent to child',
    input: {
      direction: 'PARENT_TO_CHILD',
      targetWorkspaceId: 'child-1',
      sourceWorkspace: {
        id: 'parent-1',
        name: 'Parent WS',
        projectName: 'Parent Project',
      },
      message: 'hello child',
      buildUiEvent: ({ sourceWorkspace, message, timestamp }) => ({
        type: 'parent_workspace_update',
        parentWorkspaceId: sourceWorkspace.id,
        parentWorkspaceName: sourceWorkspace.name,
        parentProjectName: sourceWorkspace.projectName,
        text: message,
        timestamp,
      }),
    },
    notification: parentNotification,
    expectedPersistenceInput: {
      parentWorkspaceId: 'parent-1',
      targetChildWorkspaceId: 'child-1',
      message: 'hello child',
    },
    expectedQueueText:
      '[Message from parent workspace "Parent WS"]: hello child\n\n<!-- factory-factory-workspace-notification:notification-parent -->',
    expectedUiEvent: {
      type: 'parent_workspace_update',
      parentWorkspaceId: 'parent-1',
      parentWorkspaceName: 'Parent WS',
      parentProjectName: 'Parent Project',
      text: 'hello child',
      timestamp: expect.any(String),
    },
  },
];

function mockPersistedNotification(testCase: DeliveryCase): void {
  if (testCase.input.direction === 'CHILD_TO_PARENT') {
    mockPersistChildNotification.mockResolvedValue(testCase.notification);
    return;
  }
  mockPersistParentNotification.mockResolvedValue(testCase.notification);
}

function expectPersistence(testCase: DeliveryCase): void {
  const persistenceMock =
    testCase.input.direction === 'CHILD_TO_PARENT'
      ? mockPersistChildNotification
      : mockPersistParentNotification;
  expect(persistenceMock).toHaveBeenCalledWith(testCase.expectedPersistenceInput);
}

describe.each(deliveryCases)('deliverWorkspaceNotification: $name', (testCase) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPersistedNotification(testCase);
    mockFindSessionsByWorkspaceId.mockResolvedValue([
      { id: 'session-old', status: 'RUNNING' },
      { id: 'session-current', status: 'IDLE' },
      { id: 'session-stopped', status: 'STOPPED' },
    ]);
    mockHasQueuedMessage.mockReturnValue(false);
    mockEnqueue.mockReturnValue({ position: 0 });
    mockAppendClaudeEvent.mockReturnValue(7);
    mockTryDispatchNextMessage.mockResolvedValue(undefined);
  });

  it('persists first, queues the latest active session, publishes its UI event, and dispatches', async () => {
    await expect(deliverWorkspaceNotification(testCase.input)).resolves.toEqual({
      delivered: true,
    });

    expectPersistence(testCase);
    expect(mockFindSessionsByWorkspaceId).toHaveBeenCalledWith(testCase.input.targetWorkspaceId);
    expect(mockHasQueuedMessage).toHaveBeenCalledWith(
      'session-current',
      `workspace-notification-${testCase.notification.id}`
    );
    expect(mockEnqueue).toHaveBeenCalledWith('session-current', {
      id: `workspace-notification-${testCase.notification.id}`,
      text: testCase.expectedQueueText,
      timestamp: expect.any(String),
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    expect(mockAppendClaudeEvent).toHaveBeenCalledWith('session-current', testCase.expectedUiEvent);
    expect(mockEmitDelta).toHaveBeenCalledWith('session-current', {
      type: 'agent_message',
      data: testCase.expectedUiEvent,
      order: 7,
    });
    expect(mockTryDispatchNextMessage).toHaveBeenCalledWith('session-current');

    const persistenceMock =
      testCase.input.direction === 'CHILD_TO_PARENT'
        ? mockPersistChildNotification
        : mockPersistParentNotification;
    expect(persistenceMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockFindSessionsByWorkspaceId.mock.invocationCallOrder[0] as number
    );
    expect(mockEnqueue.mock.invocationCallOrder[0]).toBeLessThan(
      mockAppendClaudeEvent.mock.invocationCallOrder[0] as number
    );
    expect(mockEmitDelta.mock.invocationCallOrder[0]).toBeLessThan(
      mockTryDispatchNextMessage.mock.invocationCallOrder[0] as number
    );
  });

  it('resolves without awaiting the dispatched turn (fire-and-forget)', async () => {
    // tryDispatchNextMessage awaits the target's entire agent turn. If
    // deliverWorkspaceNotification awaited it, the sendMessageTo{Child,Parent}
    // mutation — and thus the caller's blocked MCP tool call — would hang for the
    // whole turn, tripping the external client's timeout and causing a retry that
    // persists a duplicate notification (H1). Simulate a turn that never settles
    // and assert delivery still resolves promptly.
    let resolveDispatch: (() => void) | undefined;
    mockTryDispatchNextMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDispatch = resolve;
      })
    );

    await expect(deliverWorkspaceNotification(testCase.input)).resolves.toEqual({
      delivered: true,
    });

    // The dispatch was kicked off but not awaited.
    expect(mockTryDispatchNextMessage).toHaveBeenCalledWith('session-current');
    resolveDispatch?.();
  });

  it('does not reject when the detached dispatch fails; logs a warning instead', async () => {
    mockTryDispatchNextMessage.mockRejectedValue(new Error('dispatch boom'));

    await expect(deliverWorkspaceNotification(testCase.input)).resolves.toEqual({
      delivered: true,
    });

    // Allow the detached rejection handler to run.
    await Promise.resolve();
    expect(mockWarn).toHaveBeenCalledWith(
      'deliverWorkspaceNotification: detached dispatch failed',
      expect.objectContaining({
        sessionId: 'session-current',
        notificationId: testCase.notification.id,
        error: 'dispatch boom',
      })
    );
  });

  it('keeps the persisted notification pending when no session is active', async () => {
    mockFindSessionsByWorkspaceId.mockResolvedValue([{ id: 'session-stopped', status: 'STOPPED' }]);

    await expect(deliverWorkspaceNotification(testCase.input)).resolves.toEqual({
      delivered: false,
    });

    expectPersistence(testCase);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockAppendClaudeEvent).not.toHaveBeenCalled();
    expect(mockEmitDelta).not.toHaveBeenCalled();
    expect(mockTryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('returns pending when persistence cannot resolve a workspace', async () => {
    mockPersistChildNotification.mockResolvedValue(null);
    mockPersistParentNotification.mockResolvedValue(null);

    await expect(deliverWorkspaceNotification(testCase.input)).resolves.toEqual({
      delivered: false,
    });

    expectPersistence(testCase);
    expect(mockFindSessionsByWorkspaceId).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('deduplicates a notification already queued by session startup', async () => {
    mockHasQueuedMessage.mockReturnValue(true);

    await expect(deliverWorkspaceNotification(testCase.input)).resolves.toEqual({
      delivered: true,
    });

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockAppendClaudeEvent).not.toHaveBeenCalled();
    expect(mockEmitDelta).not.toHaveBeenCalled();
    expect(mockTryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('leaves the notification pending and suppresses UI delivery when enqueue rejects it', async () => {
    mockEnqueue.mockReturnValue({ error: 'queue full' });

    await expect(deliverWorkspaceNotification(testCase.input)).resolves.toEqual({
      delivered: false,
    });

    expect(mockWarn).toHaveBeenCalledWith(
      'deliverWorkspaceNotification: live enqueue failed, left pending',
      {
        direction: testCase.input.direction,
        notificationId: testCase.notification.id,
        sessionId: 'session-current',
        error: 'queue full',
      }
    );
    expect(mockAppendClaudeEvent).not.toHaveBeenCalled();
    expect(mockEmitDelta).not.toHaveBeenCalled();
    expect(mockTryDispatchNextMessage).not.toHaveBeenCalled();
  });
});
