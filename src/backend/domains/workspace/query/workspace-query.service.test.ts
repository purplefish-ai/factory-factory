import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceGitHubBridge,
  WorkspacePRSnapshotBridge,
  WorkspaceSessionBridge,
} from '@/backend/domains/workspace/bridges';
import { workspaceArchiveTrackerService } from '@/backend/domains/workspace/lifecycle/archive-tracker.service';
import { WorkspaceStatus } from '@/shared/core';
import { workspaceQueryService } from './workspace-query.service';

const mockFindByProjectIdWithSessions = vi.fn();
const mockFindByProjectId = vi.fn();
const mockFindById = vi.fn();
const mockFindByIdWithProject = vi.fn();
const mockWorkspaceUpdate = vi.fn();
const mockProjectFindById = vi.fn();
const mockDeriveWorkspaceRuntimeState = vi.fn();
const mockReadConfig = vi.fn();
const mockGetWorkspaceGitStats = vi.fn();

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findByProjectIdWithSessions: (...args: unknown[]) => mockFindByProjectIdWithSessions(...args),
    findByProjectId: (...args: unknown[]) => mockFindByProjectId(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    findByIdWithProject: (...args: unknown[]) => mockFindByIdWithProject(...args),
    update: (...args: unknown[]) => mockWorkspaceUpdate(...args),
  },
}));

vi.mock('@/backend/resource_accessors/project.accessor', () => ({
  projectAccessor: {
    findById: (...args: unknown[]) => mockProjectFindById(...args),
  },
}));

vi.mock('@/backend/domains/workspace/state/workspace-runtime-state', () => ({
  deriveWorkspaceRuntimeState: (...args: unknown[]) => mockDeriveWorkspaceRuntimeState(...args),
}));

vi.mock('@/backend/services/factory-config.service', () => ({
  FactoryConfigService: {
    readConfig: (...args: unknown[]) => mockReadConfig(...args),
  },
}));

vi.mock('@/backend/services/git-ops.service', () => ({
  gitOpsService: {
    getWorkspaceGitStats: (...args: unknown[]) => mockGetWorkspaceGitStats(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('WorkspaceQueryService', () => {
  const mockIsAnySessionWorking = vi.fn<WorkspaceSessionBridge['isAnySessionWorking']>();
  const mockGetAllPendingRequests = vi.fn<WorkspaceSessionBridge['getAllPendingRequests']>();
  const mockSessionBridge: WorkspaceSessionBridge = {
    isAnySessionWorking: mockIsAnySessionWorking,
    getAllPendingRequests: mockGetAllPendingRequests,
  };

  const mockGithubCheckHealth = vi.fn();
  const mockGithubListReviewRequests = vi.fn();
  const mockGithubBridge: WorkspaceGitHubBridge = {
    checkHealth: mockGithubCheckHealth,
    listReviewRequests: mockGithubListReviewRequests,
  };

  const mockRefreshWorkspace = vi.fn();
  const mockPrSnapshotBridge: WorkspacePRSnapshotBridge = {
    refreshWorkspace: mockRefreshWorkspace,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceArchiveTrackerService.reset();

    workspaceQueryService.configure({
      session: mockSessionBridge,
      github: mockGithubBridge,
      prSnapshot: mockPrSnapshotBridge,
    });
  });

  it('listWithRuntimeState maps working state and pending request types', async () => {
    mockFindByProjectIdWithSessions.mockResolvedValue([
      { id: 'ws-1', name: 'Workspace 1' },
      { id: 'ws-2', name: 'Workspace 2' },
      { id: 'ws-3', name: 'Workspace 3' },
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

  it('listWithKanbanState filters hidden columns and applies runtime-derived flags', async () => {
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'w1',
        status: WorkspaceStatus.READY,
        prState: 'NONE',
        hasHadSessions: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'w2',
        status: WorkspaceStatus.READY,
        prState: 'OPEN',
        hasHadSessions: true,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);

    mockDeriveWorkspaceRuntimeState.mockImplementation((workspace: { id: string }) => ({
      sessionIds: [workspace.id],
      isWorking: false,
      flowState: {
        shouldAnimateRatchetButton: workspace.id === 'w2',
        phase: 'HAS_PR',
        ciObservation: 'CHECKS_UNKNOWN',
      },
    }));
    mockGetAllPendingRequests.mockReturnValue(new Map([['w2', { toolName: 'AskUserQuestion' }]]));

    const result = await workspaceQueryService.listWithKanbanState({ projectId: 'proj-1' });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'w2',
      kanbanColumn: 'WAITING',
      pendingRequestType: 'user_question',
      ratchetButtonAnimated: true,
      flowPhase: 'HAS_PR',
    });
  });

  it('getProjectSummaryState computes git stats and caches review count', async () => {
    mockProjectFindById.mockResolvedValue({ id: 'p1', defaultBranch: 'main' });
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'w1',
        name: 'W1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        worktreePath: '/tmp/w1',
        branchName: 'feature/w1',
        prUrl: null,
        prNumber: null,
        prState: 'NONE',
        prCiStatus: null,
        ratchetEnabled: false,
        ratchetState: 'IDLE',
        runScriptStatus: 'IDLE',
        cachedKanbanColumn: 'WAITING',
        stateComputedAt: null,
        agentSessions: [{ updatedAt: new Date('2026-01-03T00:00:00.000Z') }],
        terminalSessions: [],
      },
      {
        id: 'w2',
        name: 'W2',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        worktreePath: null,
        branchName: null,
        prUrl: 'https://github.com/o/r/pull/2',
        prNumber: 2,
        prState: 'OPEN',
        prCiStatus: 'PENDING',
        ratchetEnabled: true,
        ratchetState: 'REVIEW_PENDING',
        runScriptStatus: 'RUNNING',
        cachedKanbanColumn: 'WORKING',
        stateComputedAt: new Date('2026-01-02T10:00:00.000Z'),
        agentSessions: [],
        terminalSessions: [{ updatedAt: new Date('2026-01-04T00:00:00.000Z') }],
      },
    ]);

    mockDeriveWorkspaceRuntimeState.mockImplementation((workspace: { id: string }) => ({
      sessionIds: [workspace.id],
      isWorking: workspace.id === 'w2',
      flowState: {
        shouldAnimateRatchetButton: workspace.id === 'w2',
        phase: workspace.id === 'w2' ? 'HAS_PR' : 'NO_PR',
        ciObservation: 'CHECKS_UNKNOWN',
      },
    }));
    mockGetAllPendingRequests.mockReturnValue(new Map());

    mockGetWorkspaceGitStats.mockResolvedValueOnce({
      total: 3,
      additions: 2,
      deletions: 1,
      hasUncommitted: true,
    });

    mockGithubCheckHealth.mockResolvedValue({ isInstalled: true, isAuthenticated: true });
    mockGithubListReviewRequests.mockResolvedValue([
      { reviewDecision: 'APPROVED' },
      { reviewDecision: 'CHANGES_REQUESTED' },
    ]);

    const first = await workspaceQueryService.getProjectSummaryState('p1');
    expect(first.reviewCount).toBe(1);
    expect(first.workspaces).toHaveLength(2);
    expect(first.workspaces[0]).toMatchObject({
      id: 'w1',
      isWorking: false,
      gitStats: expect.objectContaining({ total: 3 }),
    });

    mockGithubListReviewRequests.mockClear();
    const second = await workspaceQueryService.getProjectSummaryState('p1');
    expect(second.reviewCount).toBe(1);
    expect(mockGithubListReviewRequests).not.toHaveBeenCalled();
  });

  it('filters out workspaces currently archiving from project summary state results', async () => {
    workspaceArchiveTrackerService.markArchiving('ws-2');
    mockProjectFindById.mockResolvedValue({ id: 'p1', defaultBranch: 'main' });
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'ws-1',
        name: 'Workspace 1',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        worktreePath: null,
        branchName: null,
        prUrl: null,
        prNumber: null,
        prState: 'NONE',
        prCiStatus: null,
        ratchetEnabled: false,
        ratchetState: 'IDLE',
        runScriptStatus: 'IDLE',
        cachedKanbanColumn: 'WAITING',
        stateComputedAt: null,
        agentSessions: [],
        terminalSessions: [],
      },
      {
        id: 'ws-2',
        name: 'Workspace 2',
        createdAt: new Date('2026-02-02T00:00:00.000Z'),
        worktreePath: null,
        branchName: null,
        prUrl: null,
        prNumber: null,
        prState: 'NONE',
        prCiStatus: null,
        ratchetEnabled: false,
        ratchetState: 'IDLE',
        runScriptStatus: 'IDLE',
        cachedKanbanColumn: 'WAITING',
        stateComputedAt: null,
        agentSessions: [],
        terminalSessions: [],
      },
    ]);
    mockDeriveWorkspaceRuntimeState.mockImplementation((workspace: { id: string }) => ({
      sessionIds: [workspace.id],
      isWorking: false,
      flowState: {
        shouldAnimateRatchetButton: false,
        phase: 'NO_PR',
        ciObservation: 'CHECKS_UNKNOWN',
      },
    }));
    mockGetAllPendingRequests.mockReturnValue(new Map());
    mockGithubCheckHealth.mockResolvedValue({ isInstalled: false, isAuthenticated: false });

    const result = await workspaceQueryService.getProjectSummaryState('p1');

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]?.id).toBe('ws-1');
  });

  it('refreshFactoryConfigs updates script commands and reports per-workspace errors', async () => {
    mockFindByProjectId.mockResolvedValue([
      { id: 'w1', worktreePath: '/tmp/w1' },
      { id: 'w2', worktreePath: '/tmp/w2' },
      { id: 'w3', worktreePath: null },
    ]);

    mockReadConfig
      .mockResolvedValueOnce({ scripts: { run: 'pnpm dev', cleanup: 'pkill node' } })
      .mockRejectedValueOnce(new Error('bad config'));
    mockWorkspaceUpdate.mockResolvedValue(undefined);

    const result = await workspaceQueryService.refreshFactoryConfigs('p1');

    expect(result).toEqual({
      updatedCount: 1,
      totalWorkspaces: 3,
      errors: [{ workspaceId: 'w2', error: 'bad config' }],
    });
    expect(mockWorkspaceUpdate).toHaveBeenCalledWith('w1', {
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: 'pkill node',
    });
  });

  it('getFactoryConfig validates project and handles read errors', async () => {
    mockProjectFindById.mockResolvedValueOnce(null);
    await expect(workspaceQueryService.getFactoryConfig('missing')).rejects.toThrow(
      'Project not found'
    );

    mockProjectFindById.mockResolvedValueOnce({ id: 'p1', repoPath: '/repo' });
    mockReadConfig.mockResolvedValueOnce({ scripts: { run: 'pnpm dev' } });
    await expect(workspaceQueryService.getFactoryConfig('p1')).resolves.toEqual({
      scripts: { run: 'pnpm dev' },
    });

    mockProjectFindById.mockResolvedValueOnce({ id: 'p1', repoPath: '/repo' });
    mockReadConfig.mockRejectedValueOnce(new Error('boom'));
    await expect(workspaceQueryService.getFactoryConfig('p1')).resolves.toBeNull();
  });

  it('syncPRStatus and syncAllPRStatuses handle success and failure paths', async () => {
    mockFindById.mockResolvedValueOnce(null);
    await expect(workspaceQueryService.syncPRStatus('missing')).rejects.toThrow(
      'Workspace not found'
    );

    mockFindById.mockResolvedValueOnce({ id: 'w1', prUrl: null });
    await expect(workspaceQueryService.syncPRStatus('w1')).resolves.toEqual({
      success: false,
      reason: 'no_pr_url',
    });

    mockFindById.mockResolvedValueOnce({ id: 'w1', prUrl: 'https://github.com/o/r/pull/1' });
    mockRefreshWorkspace.mockResolvedValueOnce({ success: false });
    await expect(workspaceQueryService.syncPRStatus('w1')).resolves.toEqual({
      success: false,
      reason: 'fetch_failed',
    });

    mockFindById.mockResolvedValueOnce({ id: 'w1', prUrl: 'https://github.com/o/r/pull/1' });
    mockRefreshWorkspace.mockResolvedValueOnce({
      success: true,
      snapshot: { prNumber: 1, prState: 'OPEN' },
    });
    await expect(workspaceQueryService.syncPRStatus('w1')).resolves.toEqual({
      success: true,
      prState: 'OPEN',
    });

    mockFindByProjectIdWithSessions.mockResolvedValueOnce([
      { id: 'w1', prUrl: null },
      { id: 'w2', prUrl: null },
    ]);
    await expect(workspaceQueryService.syncAllPRStatuses('p1')).resolves.toEqual({
      synced: 0,
      failed: 0,
    });

    mockFindByProjectIdWithSessions.mockResolvedValueOnce([
      { id: 'w1', prUrl: 'https://github.com/o/r/pull/1' },
      { id: 'w2', prUrl: 'https://github.com/o/r/pull/2' },
    ]);
    mockRefreshWorkspace
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });

    await expect(workspaceQueryService.syncAllPRStatuses('p1')).resolves.toEqual({
      synced: 1,
      failed: 1,
    });
  });

  it('hasChanges checks workspace metadata and git stats safely', async () => {
    mockFindByIdWithProject.mockResolvedValueOnce(null);
    await expect(workspaceQueryService.hasChanges('w1')).resolves.toBe(false);

    mockFindByIdWithProject.mockResolvedValueOnce({
      id: 'w1',
      worktreePath: '/tmp/w1',
      project: { defaultBranch: 'main' },
    });
    mockGetWorkspaceGitStats.mockResolvedValueOnce({
      total: 0,
      additions: 0,
      deletions: 0,
      hasUncommitted: false,
    });
    await expect(workspaceQueryService.hasChanges('w1')).resolves.toBe(false);

    mockFindByIdWithProject.mockResolvedValueOnce({
      id: 'w1',
      worktreePath: '/tmp/w1',
      project: { defaultBranch: 'main' },
    });
    mockGetWorkspaceGitStats.mockResolvedValueOnce({
      total: 1,
      additions: 1,
      deletions: 0,
      hasUncommitted: false,
    });
    await expect(workspaceQueryService.hasChanges('w1')).resolves.toBe(true);

    mockFindByIdWithProject.mockResolvedValueOnce({
      id: 'w1',
      worktreePath: '/tmp/w1',
      project: { defaultBranch: 'main' },
    });
    mockGetWorkspaceGitStats.mockRejectedValueOnce(new Error('git failed'));
    await expect(workspaceQueryService.hasChanges('w1')).resolves.toBe(false);
  });

  it('filters out workspaces currently archiving from kanban list results', async () => {
    workspaceArchiveTrackerService.markArchiving('ws-2');
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'ws-1',
        name: 'Workspace 1',
        status: 'READY',
        prState: 'NONE',
        hasHadSessions: true,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      {
        id: 'ws-2',
        name: 'Workspace 2',
        status: 'READY',
        prState: 'NONE',
        hasHadSessions: true,
        createdAt: new Date('2026-02-02T00:00:00.000Z'),
      },
    ]);
    mockDeriveWorkspaceRuntimeState.mockReturnValue({
      sessionIds: [],
      isWorking: false,
      flowState: {
        shouldAnimateRatchetButton: false,
        phase: 'NO_PR',
        ciObservation: 'CHECKS_UNKNOWN',
      },
    });
    mockGetAllPendingRequests.mockReturnValue(new Map());

    const result = await workspaceQueryService.listWithKanbanState({ projectId: 'proj-1' });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('ws-1');
  });
});
