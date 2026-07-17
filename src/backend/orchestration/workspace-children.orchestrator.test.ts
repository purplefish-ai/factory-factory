import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';

// --- Module mocks (before imports) ---

vi.mock('@/backend/services/session', () => ({
  sessionDataService: {
    createAgentSession: vi.fn(),
  },
  sessionProviderResolverService: {
    resolveProviderForWorkspaceCreation: vi.fn(),
  },
}));

vi.mock('@/backend/services/workspace', () => ({
  projectAccessor: {
    findById: vi.fn(),
  },
  WorkspaceCreationService: class {
    create = vi.fn();
  },
  workspaceAccessor: {
    findByIdWithProject: vi.fn(),
    findRawById: vi.fn(),
  },
  workspaceNotificationAccessor: {
    create: vi.fn(),
  },
}));

vi.mock('./workspace-init.orchestrator', () => ({
  initializeWorkspaceWorktree: vi.fn(),
}));

import {
  projectAccessor,
  workspaceAccessor,
  workspaceNotificationAccessor,
} from '@/backend/services/workspace';
import {
  createChildWorkspace,
  persistChildNotification,
  persistParentNotification,
} from './workspace-children.orchestrator';

const mockFindByIdWithProject = vi.mocked(workspaceAccessor.findByIdWithProject);
const mockFindRawById = vi.mocked(workspaceAccessor.findRawById);
const mockNotificationCreate = vi.mocked(workspaceNotificationAccessor.create);

describe('createChildWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws a not-found application error when the target project is missing', async () => {
    vi.mocked(projectAccessor.findById).mockResolvedValue(null);

    const error = await createChildWorkspace({
      parentWorkspaceId: 'parent-1',
      projectId: 'missing-project',
      name: 'Child workspace',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Project not found: missing-project',
    });
  });
});

describe('persistChildNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates and returns the notification row', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'child-1',
      name: 'Child WS',
      project: { name: 'Child Project' },
    } as never);
    mockFindRawById.mockResolvedValue({ id: 'parent-1' } as never);
    const createdNotification = { id: 'notif-1', message: 'hello' };
    mockNotificationCreate.mockResolvedValue(createdNotification as never);

    const result = await persistChildNotification({
      parentWorkspaceId: 'parent-1',
      sourceWorkspaceId: 'child-1',
      message: 'hello',
    });

    expect(mockNotificationCreate).toHaveBeenCalledWith({
      workspaceId: 'parent-1',
      sourceWorkspaceId: 'child-1',
      sourceWorkspaceName: 'Child WS',
      sourceProjectName: 'Child Project',
      message: 'hello',
    });
    expect(result).toBe(createdNotification);
  });

  it('returns null without creating when a workspace is missing', async () => {
    mockFindByIdWithProject.mockResolvedValue(null as never);
    mockFindRawById.mockResolvedValue({ id: 'parent-1' } as never);

    const result = await persistChildNotification({
      parentWorkspaceId: 'parent-1',
      sourceWorkspaceId: 'child-1',
      message: 'hello',
    });

    expect(mockNotificationCreate).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe('persistParentNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates and returns the notification row', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'parent-1',
      name: 'Parent WS',
      project: { name: 'Parent Project' },
    } as never);
    mockFindRawById.mockResolvedValue({ id: 'child-1' } as never);
    const createdNotification = { id: 'notif-2', message: 'do this' };
    mockNotificationCreate.mockResolvedValue(createdNotification as never);

    const result = await persistParentNotification({
      parentWorkspaceId: 'parent-1',
      targetChildWorkspaceId: 'child-1',
      message: 'do this',
    });

    expect(mockNotificationCreate).toHaveBeenCalledWith({
      workspaceId: 'child-1',
      sourceWorkspaceId: 'parent-1',
      sourceWorkspaceName: 'Parent WS',
      sourceProjectName: 'Parent Project',
      message: 'do this',
      direction: 'PARENT_TO_CHILD',
    });
    expect(result).toBe(createdNotification);
  });

  it('returns null without creating when a workspace is missing', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'parent-1',
      name: 'Parent WS',
      project: { name: 'Parent Project' },
    } as never);
    mockFindRawById.mockResolvedValue(null as never);

    const result = await persistParentNotification({
      parentWorkspaceId: 'parent-1',
      targetChildWorkspaceId: 'child-1',
      message: 'do this',
    });

    expect(mockNotificationCreate).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
