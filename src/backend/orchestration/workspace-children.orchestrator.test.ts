import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';

const { mockCreateWorkspace } = vi.hoisted(() => ({ mockCreateWorkspace: vi.fn() }));

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
  projectManagementService: {
    findById: vi.fn(),
  },
  WorkspaceCreationService: class {
    create = mockCreateWorkspace;
  },
  workspaceDataService: {
    findByIdWithProject: vi.fn(),
    exists: vi.fn(),
  },
  workspaceNotificationService: {
    notifyParent: vi.fn(),
    notifyChild: vi.fn(),
  },
}));

vi.mock('./workspace-init.orchestrator', () => ({
  initializeWorkspaceWorktree: vi.fn(async () => undefined),
}));

import {
  projectManagementService,
  workspaceDataService,
  workspaceNotificationService,
} from '@/backend/services/workspace';
import {
  createChildWorkspace,
  persistChildNotification,
  persistParentNotification,
} from './workspace-children.orchestrator';

const mockFindByIdWithProject = vi.mocked(workspaceDataService.findByIdWithProject);
const mockExists = vi.mocked(workspaceDataService.exists);
const mockNotifyParent = vi.mocked(workspaceNotificationService.notifyParent);
const mockNotifyChild = vi.mocked(workspaceNotificationService.notifyChild);

function createProject(
  isArchived: boolean
): NonNullable<Awaited<ReturnType<typeof projectManagementService.findById>>> {
  return {
    id: 'archived-project',
    name: 'Archived project',
    slug: 'archived-project',
    workspaces: [],
    repoPath: '/repo',
    worktreeBasePath: '/worktrees',
    defaultBranch: 'main',
    githubOwner: null,
    githubRepo: null,
    isArchived,
    issueProvider: 'GITHUB',
    issueTrackerConfig: null,
    startupScriptCommand: null,
    startupScriptPath: null,
    startupScriptTimeout: 300,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('createChildWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an archived target project before creating a workspace', async () => {
    vi.mocked(projectManagementService.findById).mockResolvedValue(createProject(true));
    mockCreateWorkspace.mockResolvedValue({ id: 'unexpected-child' });
    const error = await createChildWorkspace({
      parentWorkspaceId: 'parent-1',
      projectId: 'archived-project',
      name: 'Child workspace',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Cannot create a child workspace in an archived project',
    });
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
  });

  it('continues to create child workspaces in active projects', async () => {
    vi.mocked(projectManagementService.findById).mockResolvedValue(createProject(false));
    mockCreateWorkspace.mockResolvedValue({ id: 'active-child' });

    await expect(
      createChildWorkspace({
        parentWorkspaceId: 'parent-1',
        projectId: 'active-project',
        name: 'Child workspace',
      })
    ).resolves.toBe('active-child');
  });

  it('throws a not-found application error when the target project is missing', async () => {
    vi.mocked(projectManagementService.findById).mockResolvedValue(null);

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
    mockExists.mockResolvedValue(true);
    const createdNotification = { id: 'notif-1', message: 'hello' };
    mockNotifyParent.mockResolvedValue(createdNotification as never);

    const result = await persistChildNotification({
      parentWorkspaceId: 'parent-1',
      sourceWorkspaceId: 'child-1',
      message: 'hello',
    });

    expect(mockNotifyParent).toHaveBeenCalledWith({
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
    mockExists.mockResolvedValue(true);

    const result = await persistChildNotification({
      parentWorkspaceId: 'parent-1',
      sourceWorkspaceId: 'child-1',
      message: 'hello',
    });

    expect(mockNotifyParent).not.toHaveBeenCalled();
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
    mockExists.mockResolvedValue(true);
    const createdNotification = { id: 'notif-2', message: 'do this' };
    mockNotifyChild.mockResolvedValue(createdNotification as never);

    const result = await persistParentNotification({
      parentWorkspaceId: 'parent-1',
      targetChildWorkspaceId: 'child-1',
      message: 'do this',
    });

    expect(mockNotifyChild).toHaveBeenCalledWith({
      workspaceId: 'child-1',
      sourceWorkspaceId: 'parent-1',
      sourceWorkspaceName: 'Parent WS',
      sourceProjectName: 'Parent Project',
      message: 'do this',
    });
    expect(result).toBe(createdNotification);
  });

  it('returns null without creating when a workspace is missing', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'parent-1',
      name: 'Parent WS',
      project: { name: 'Parent Project' },
    } as never);
    mockExists.mockResolvedValue(false);

    const result = await persistParentNotification({
      parentWorkspaceId: 'parent-1',
      targetChildWorkspaceId: 'child-1',
      message: 'do this',
    });

    expect(mockNotifyChild).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
