import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceGitHubBridge,
  WorkspacePRSnapshotBridge,
  WorkspaceSessionBridge,
} from '@/backend/domains/workspace/bridges';
import { workspaceQueryService } from './workspace-query.service';

const mockFindByProjectIdWithSessions = vi.fn();
const mockDeriveWorkspaceRuntimeState = vi.fn();

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findByProjectIdWithSessions: (...args: unknown[]) => mockFindByProjectIdWithSessions(...args),
    findByProjectId: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('@/backend/domains/workspace/state/workspace-runtime-state', () => ({
  deriveWorkspaceRuntimeState: (...args: unknown[]) => mockDeriveWorkspaceRuntimeState(...args),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('WorkspaceQueryService.listWithRuntimeState', () => {
  const mockIsAnySessionWorking = vi.fn<WorkspaceSessionBridge['isAnySessionWorking']>();
  const mockGetAllPendingRequests = vi.fn<WorkspaceSessionBridge['getAllPendingRequests']>();
  const mockSessionBridge: WorkspaceSessionBridge = {
    isAnySessionWorking: mockIsAnySessionWorking,
    getAllPendingRequests: mockGetAllPendingRequests,
  };

  const mockGithubBridge: WorkspaceGitHubBridge = {
    checkHealth: vi.fn(),
    listReviewRequests: vi.fn(),
  };

  const mockPrSnapshotBridge: WorkspacePRSnapshotBridge = {
    refreshWorkspace: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    workspaceQueryService.configure({
      session: mockSessionBridge,
      github: mockGithubBridge,
      prSnapshot: mockPrSnapshotBridge,
    });
  });

  it('returns isWorking and pendingRequestType derived from runtime + pending requests', async () => {
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'ws-1',
        name: 'Workspace 1',
      },
      {
        id: 'ws-2',
        name: 'Workspace 2',
      },
      {
        id: 'ws-3',
        name: 'Workspace 3',
      },
    ]);

    mockDeriveWorkspaceRuntimeState.mockImplementation((workspace: { id: string }) => {
      if (workspace.id === 'ws-1') {
        return { sessionIds: ['s-1'], isWorking: false };
      }
      if (workspace.id === 'ws-2') {
        return { sessionIds: ['s-2'], isWorking: true };
      }
      return { sessionIds: ['s-3'], isWorking: false };
    });

    mockGetAllPendingRequests.mockReturnValue(
      new Map([
        ['s-1', { toolName: 'ExitPlanMode' }],
        ['s-2', { toolName: 'SomeOtherPermissionTool' }],
      ])
    );

    const result = await workspaceQueryService.listWithRuntimeState({ projectId: 'proj-1' });

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      id: 'ws-1',
      isWorking: false,
      pendingRequestType: 'plan_approval',
    });
    expect(result[1]).toMatchObject({
      id: 'ws-2',
      isWorking: true,
      pendingRequestType: 'permission_request',
    });
    expect(result[2]).toMatchObject({
      id: 'ws-3',
      isWorking: false,
      pendingRequestType: null,
    });
  });

  it('keeps user_question mapping for AskUserQuestion', async () => {
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'ws-1',
        name: 'Workspace 1',
      },
    ]);

    mockDeriveWorkspaceRuntimeState.mockReturnValue({ sessionIds: ['s-1'], isWorking: false });

    mockGetAllPendingRequests.mockReturnValue(new Map([['s-1', { toolName: 'AskUserQuestion' }]]));

    const result = await workspaceQueryService.listWithRuntimeState({ projectId: 'proj-1' });

    expect(result[0]).toMatchObject({
      id: 'ws-1',
      pendingRequestType: 'user_question',
    });
  });

  it('passes list filters through to accessor', async () => {
    mockFindByProjectIdWithSessions.mockResolvedValue([]);
    mockGetAllPendingRequests.mockReturnValue(new Map());

    await workspaceQueryService.listWithRuntimeState({
      projectId: 'proj-1',
      status: 'READY',
      limit: 20,
      offset: 5,
    });

    expect(mockFindByProjectIdWithSessions).toHaveBeenCalledWith('proj-1', {
      status: 'READY',
      limit: 20,
      offset: 5,
    });
  });
});
