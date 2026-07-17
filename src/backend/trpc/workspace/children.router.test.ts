import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliverWorkspaceNotificationInput } from '@/backend/orchestration/workspace-notification-delivery.orchestrator';

const mockArchiveWorkspace = vi.hoisted(() => vi.fn());
const mockCreateChildWorkspace = vi.hoisted(() => vi.fn());
const mockDeliverWorkspaceNotification = vi.hoisted(() =>
  vi.fn<(input: DeliverWorkspaceNotificationInput) => Promise<{ delivered: boolean }>>()
);
const mockFindByIdWithProject = vi.hoisted(() => vi.fn());
const mockFindChildrenWithStatus = vi.hoisted(() => vi.fn());
const mockFindParentWorkspace = vi.hoisted(() => vi.fn());
const mockCountPending = vi.hoisted(() => vi.fn());

vi.mock('@/backend/orchestration/workspace-archive.orchestrator', () => ({
  archiveWorkspace: (...args: unknown[]) => mockArchiveWorkspace(...args),
}));

vi.mock('@/backend/orchestration/workspace-children.orchestrator', () => ({
  createChildWorkspace: (...args: unknown[]) => mockCreateChildWorkspace(...args),
}));

vi.mock('@/backend/orchestration/workspace-notification-delivery.orchestrator', () => ({
  deliverWorkspaceNotification: (input: DeliverWorkspaceNotificationInput) =>
    mockDeliverWorkspaceNotification(input),
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceAccessor: {
    findByIdWithProject: (...args: unknown[]) => mockFindByIdWithProject(...args),
    findChildrenWithStatus: (...args: unknown[]) => mockFindChildrenWithStatus(...args),
    findParentWorkspace: (...args: unknown[]) => mockFindParentWorkspace(...args),
  },
  workspaceNotificationAccessor: {
    countPending: (...args: unknown[]) => mockCountPending(...args),
  },
}));

import { workspaceChildrenRouter } from './children.trpc';

function createCaller(requestTrust?: {
  remoteAddress?: string;
  origin?: string;
  isLocal: boolean;
}) {
  const services = {
    configService: {
      getCorsConfig: () => ({
        allowedOrigins: ['http://localhost:3000'],
        trustedLocalCidrs: [],
      }),
    },
  };
  return {
    caller: workspaceChildrenRouter.createCaller({
      requestTrust,
      appContext: { services },
    } as never),
    services,
  };
}

const child = {
  id: 'child-1',
  name: 'Child WS',
  parentWorkspaceId: 'parent-1',
  projectId: 'child-project-1',
  project: { name: 'Child Project' },
};

const parent = {
  id: 'parent-1',
  name: 'Parent WS',
  parentWorkspaceId: null,
  projectId: 'parent-project-1',
  project: { name: 'Parent Project' },
};

describe('workspaceChildrenRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliverWorkspaceNotification.mockResolvedValue({ delivered: true });
  });

  it('creates child workspaces through the child orchestration use case', async () => {
    mockCreateChildWorkspace.mockResolvedValue('child-created');
    const { caller } = createCaller();

    await expect(
      caller.createChild({
        parentWorkspaceId: 'parent-1',
        projectId: 'project-1',
        name: 'New Child',
        description: 'description',
        initialPrompt: 'start here',
        reportBackOn: 'PR ready',
      })
    ).resolves.toEqual({ workspaceId: 'child-created' });

    expect(mockCreateChildWorkspace).toHaveBeenCalledWith({
      parentWorkspaceId: 'parent-1',
      projectId: 'project-1',
      name: 'New Child',
      description: 'description',
      initialPrompt: 'start here',
      reportBackOn: 'PR ready',
    });
  });

  it('rejects child creation from an untrusted request', async () => {
    const { caller } = createCaller({
      remoteAddress: '203.0.113.10',
      origin: 'https://attacker.example',
      isLocal: false,
    });

    await expect(
      caller.createChild({
        parentWorkspaceId: 'parent-1',
        projectId: 'project-1',
        name: 'New Child',
      })
    ).rejects.toThrow('trusted local Factory Factory client');
    expect(mockCreateChildWorkspace).not.toHaveBeenCalled();
  });

  it('lists child summaries and resolves the parent summary', async () => {
    const createdAt = new Date('2026-07-17T12:00:00.000Z');
    mockFindChildrenWithStatus.mockResolvedValue([
      {
        ...child,
        description: 'Child description',
        status: 'READY',
        prState: 'NONE',
        prUrl: null,
        cachedKanbanColumn: 'WAITING',
        project: { name: 'Child Project', slug: 'child-project' },
        createdAt,
      },
    ]);
    mockFindParentWorkspace.mockResolvedValue({
      ...parent,
      project: { name: 'Parent Project', slug: 'parent-project' },
    });
    const { caller } = createCaller();

    await expect(caller.listChildren({ parentWorkspaceId: 'parent-1' })).resolves.toEqual([
      {
        id: 'child-1',
        name: 'Child WS',
        description: 'Child description',
        status: 'READY',
        prState: 'NONE',
        prUrl: null,
        cachedKanbanColumn: 'WAITING',
        projectId: 'child-project-1',
        projectName: 'Child Project',
        projectSlug: 'child-project',
        createdAt,
      },
    ]);
    await expect(caller.getParent({ childWorkspaceId: 'child-1' })).resolves.toEqual({
      id: 'parent-1',
      name: 'Parent WS',
      projectId: 'parent-project-1',
      projectName: 'Parent Project',
      projectSlug: 'parent-project',
    });
  });

  it('returns null when a child has no parent summary', async () => {
    mockFindParentWorkspace.mockResolvedValue(null);
    const { caller } = createCaller();

    await expect(caller.getParent({ childWorkspaceId: 'child-1' })).resolves.toBeNull();
  });

  it('delegates child-to-parent delivery with child metadata and UI construction', async () => {
    mockFindByIdWithProject.mockResolvedValue(child);
    const { caller } = createCaller();

    await expect(
      caller.sendMessageToParent({ childWorkspaceId: 'child-1', message: 'hello parent' })
    ).resolves.toEqual({ delivered: true });

    expect(mockDeliverWorkspaceNotification).toHaveBeenCalledWith({
      direction: 'CHILD_TO_PARENT',
      targetWorkspaceId: 'parent-1',
      sourceWorkspace: {
        id: 'child-1',
        name: 'Child WS',
        projectName: 'Child Project',
      },
      message: 'hello parent',
      buildUiEvent: expect.any(Function),
    });
    const deliveryInput = mockDeliverWorkspaceNotification.mock.calls[0]?.[0];
    if (!deliveryInput) {
      throw new Error('Expected child-to-parent delivery input');
    }
    expect(
      deliveryInput.buildUiEvent({
        sourceWorkspace: deliveryInput.sourceWorkspace,
        message: deliveryInput.message,
        timestamp: '2026-07-17T12:00:00.000Z',
      })
    ).toEqual({
      type: 'child_workspace_update',
      childWorkspaceId: 'child-1',
      childWorkspaceName: 'Child WS',
      childProjectName: 'Child Project',
      text: 'hello parent',
      timestamp: '2026-07-17T12:00:00.000Z',
    });
  });

  it.each([
    {
      workspace: null,
      expectedCode: 'NOT_FOUND',
      expectedMessage: 'Workspace not found: child-1',
    },
    {
      workspace: { ...child, parentWorkspaceId: null },
      expectedCode: 'BAD_REQUEST',
      expectedMessage: 'This workspace has no parent',
    },
  ])('rejects invalid child-to-parent relationship: $expectedCode', async (testCase) => {
    mockFindByIdWithProject.mockResolvedValue(testCase.workspace);
    const { caller } = createCaller();

    await expect(
      caller.sendMessageToParent({ childWorkspaceId: 'child-1', message: 'hello' })
    ).rejects.toMatchObject({ code: testCase.expectedCode, message: testCase.expectedMessage });
    expect(mockDeliverWorkspaceNotification).not.toHaveBeenCalled();
  });

  it('delegates parent-to-child delivery with parent metadata and UI construction', async () => {
    mockFindByIdWithProject.mockImplementation(async (workspaceId: string) =>
      workspaceId === 'child-1' ? child : parent
    );
    const { caller } = createCaller();

    await expect(
      caller.sendMessageToChild({
        parentWorkspaceId: 'parent-1',
        childWorkspaceId: 'child-1',
        message: 'hello child',
      })
    ).resolves.toEqual({ delivered: true });

    expect(mockDeliverWorkspaceNotification).toHaveBeenCalledWith({
      direction: 'PARENT_TO_CHILD',
      targetWorkspaceId: 'child-1',
      sourceWorkspace: {
        id: 'parent-1',
        name: 'Parent WS',
        projectName: 'Parent Project',
      },
      message: 'hello child',
      buildUiEvent: expect.any(Function),
    });
    const deliveryInput = mockDeliverWorkspaceNotification.mock.calls[0]?.[0];
    if (!deliveryInput) {
      throw new Error('Expected parent-to-child delivery input');
    }
    expect(
      deliveryInput.buildUiEvent({
        sourceWorkspace: deliveryInput.sourceWorkspace,
        message: deliveryInput.message,
        timestamp: '2026-07-17T12:00:01.000Z',
      })
    ).toEqual({
      type: 'parent_workspace_update',
      parentWorkspaceId: 'parent-1',
      parentWorkspaceName: 'Parent WS',
      parentProjectName: 'Parent Project',
      text: 'hello child',
      timestamp: '2026-07-17T12:00:01.000Z',
    });
  });

  it('rejects a parent-to-child message for a mismatched relationship', async () => {
    mockFindByIdWithProject.mockResolvedValue({ ...child, parentWorkspaceId: 'other-parent' });
    const { caller } = createCaller();

    await expect(
      caller.sendMessageToChild({
        parentWorkspaceId: 'parent-1',
        childWorkspaceId: 'child-1',
        message: 'hello child',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The specified child workspace does not belong to this parent',
    });
    expect(mockDeliverWorkspaceNotification).not.toHaveBeenCalled();
  });

  it('returns pending when parent metadata disappears before delivery', async () => {
    mockFindByIdWithProject.mockImplementation(async (workspaceId: string) =>
      workspaceId === 'child-1' ? child : null
    );
    const { caller } = createCaller();

    await expect(
      caller.sendMessageToChild({
        parentWorkspaceId: 'parent-1',
        childWorkspaceId: 'child-1',
        message: 'hello child',
      })
    ).resolves.toEqual({ delivered: false });
    expect(mockDeliverWorkspaceNotification).not.toHaveBeenCalled();
  });

  it('archives a validated child and counts pending notifications', async () => {
    mockFindByIdWithProject.mockResolvedValue(child);
    mockArchiveWorkspace.mockResolvedValue({ archived: true });
    mockCountPending.mockResolvedValue(3);
    const { caller, services } = createCaller();

    await expect(
      caller.archiveChild({ parentWorkspaceId: 'parent-1', childWorkspaceId: 'child-1' })
    ).resolves.toEqual({ archived: true });
    expect(mockArchiveWorkspace).toHaveBeenCalledWith(child, { commitUncommitted: true }, services);
    await expect(caller.getPendingNotificationCount({ workspaceId: 'parent-1' })).resolves.toBe(3);
  });
});
