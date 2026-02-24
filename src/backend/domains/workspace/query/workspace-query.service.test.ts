import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceGitHubBridge,
  WorkspacePRSnapshotBridge,
  WorkspaceSessionBridge,
} from '@/backend/domains/workspace/bridges';
import { deriveWorkspaceFlowState } from '@/backend/domains/workspace/state/flow-state';
import { computeKanbanColumn } from '@/backend/domains/workspace/state/kanban-state';
import { WorkspaceSnapshotStore } from '@/backend/services/workspace-snapshot-store.service';
import { CIStatus, PRState, RatchetState, RunScriptStatus, WorkspaceStatus } from '@/shared/core';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
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
const mockSyncWorkspaceCommandsFromWorktreeConfig = vi.fn();

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

vi.mock('@/backend/services/run-script-config-persistence.service', () => ({
  runScriptConfigPersistenceService: {
    syncWorkspaceCommandsFromWorktreeConfig: (...args: unknown[]) =>
      mockSyncWorkspaceCommandsFromWorktreeConfig(...args),
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
        return { sessionIds: ['s-1'], isSessionWorking: false, isWorking: false };
      }
      if (workspace.id === 'ws-2') {
        return { sessionIds: ['s-2'], isSessionWorking: true, isWorking: true };
      }
      return { sessionIds: ['s-3'], isSessionWorking: false, isWorking: false };
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
        prUrl: null,
        prState: 'NONE',
        prCiStatus: 'UNKNOWN',
        ratchetState: 'IDLE',
        hasHadSessions: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'w2',
        status: WorkspaceStatus.READY,
        prUrl: 'https://github.com/o/r/pull/2',
        prState: 'OPEN',
        prCiStatus: 'PENDING',
        ratchetState: 'REVIEW_PENDING',
        hasHadSessions: true,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);

    mockDeriveWorkspaceRuntimeState.mockImplementation((workspace: { id: string }) => ({
      sessionIds: [workspace.id],
      isSessionWorking: false,
      isWorking: false,
      flowState: {
        hasActivePr: workspace.id === 'w2',
        isWorking: false,
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
      isSessionWorking: workspace.id === 'w2',
      isWorking: workspace.id === 'w2',
      flowState: {
        hasActivePr: workspace.id === 'w2',
        isWorking: workspace.id === 'w2',
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

  it('returns derived fields equivalent to snapshot store for identical raw inputs', async () => {
    const workspace = {
      id: 'w-eq',
      projectId: 'p1',
      name: 'Equivalent Workspace',
      status: WorkspaceStatus.READY,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      worktreePath: null,
      branchName: 'feature/equivalence',
      prUrl: 'https://github.com/o/r/pull/12',
      prNumber: 12,
      prState: PRState.OPEN,
      prCiStatus: CIStatus.PENDING,
      prUpdatedAt: new Date('2026-01-01T00:10:00.000Z'),
      ratchetEnabled: true,
      ratchetState: RatchetState.REVIEW_PENDING,
      runScriptStatus: RunScriptStatus.IDLE,
      hasHadSessions: true,
      stateComputedAt: null,
      githubIssueNumber: null,
      linearIssueId: null,
      agentSessions: [{ updatedAt: new Date('2026-01-01T00:20:00.000Z') }],
      terminalSessions: [],
    };

    mockProjectFindById.mockResolvedValue({ id: 'p1', defaultBranch: 'main' });
    mockFindByProjectIdWithSessions.mockResolvedValue([workspace]);
    mockGetAllPendingRequests.mockReturnValue(new Map());
    mockGithubCheckHealth.mockResolvedValue({ isInstalled: false, isAuthenticated: false });

    const flowState = deriveWorkspaceFlowState({
      prUrl: workspace.prUrl,
      prState: workspace.prState,
      prCiStatus: workspace.prCiStatus,
      prUpdatedAt: workspace.prUpdatedAt,
      ratchetEnabled: workspace.ratchetEnabled,
      ratchetState: workspace.ratchetState,
    });
    mockDeriveWorkspaceRuntimeState.mockReturnValue({
      sessionIds: ['s-eq'],
      isSessionWorking: false,
      isWorking: flowState.isWorking,
      flowState,
    });

    const summary = await workspaceQueryService.getProjectSummaryState('p1');
    const kanban = await workspaceQueryService.listWithKanbanState({ projectId: 'p1' });
    const summaryWorkspace = summary.workspaces[0];

    const snapshotStore = new WorkspaceSnapshotStore();
    snapshotStore.configure({
      deriveFlowState: (input) =>
        deriveWorkspaceFlowState({
          ...input,
          prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
        }),
      computeKanbanColumn,
      deriveSidebarStatus: deriveWorkspaceSidebarStatus,
    });
    snapshotStore.upsert(
      workspace.id,
      {
        projectId: workspace.projectId,
        name: workspace.name,
        status: workspace.status,
        createdAt: workspace.createdAt.toISOString(),
        branchName: workspace.branchName,
        prUrl: workspace.prUrl,
        prNumber: workspace.prNumber,
        prState: workspace.prState,
        prCiStatus: workspace.prCiStatus,
        prUpdatedAt: workspace.prUpdatedAt.toISOString(),
        ratchetEnabled: workspace.ratchetEnabled,
        ratchetState: workspace.ratchetState,
        runScriptStatus: workspace.runScriptStatus,
        hasHadSessions: workspace.hasHadSessions,
        isWorking: false,
      },
      'test:equivalence',
      Date.now()
    );
    const snapshotEntry = snapshotStore.getByWorkspaceId(workspace.id);

    expect(snapshotEntry).toBeDefined();
    expect(summaryWorkspace).toBeDefined();
    expect(kanban[0]).toBeDefined();

    expect(summaryWorkspace?.flowPhase).toBe(snapshotEntry?.flowPhase);
    expect(summaryWorkspace?.ciObservation).toBe(snapshotEntry?.ciObservation);
    expect(summaryWorkspace?.sidebarStatus).toEqual(snapshotEntry?.sidebarStatus);
    expect(summaryWorkspace?.cachedKanbanColumn).toBe(snapshotEntry?.kanbanColumn);

    expect(kanban[0]?.flowPhase).toBe(snapshotEntry?.flowPhase);
    expect(kanban[0]?.ciObservation).toBe(snapshotEntry?.ciObservation);
    expect(kanban[0]?.kanbanColumn).toBe(snapshotEntry?.kanbanColumn);
  });

  it('refreshFactoryConfigs updates script commands and reports per-workspace errors', async () => {
    mockFindByProjectId.mockResolvedValue([
      { id: 'w1', worktreePath: '/tmp/w1' },
      { id: 'w2', worktreePath: '/tmp/w2' },
      { id: 'w3', worktreePath: null },
    ]);

    mockSyncWorkspaceCommandsFromWorktreeConfig
      .mockResolvedValueOnce({
        runScriptCommand: 'pnpm dev',
        runScriptPostRunCommand: null,
        runScriptCleanupCommand: 'pkill node',
      })
      .mockRejectedValueOnce(new Error('bad config'));

    const result = await workspaceQueryService.refreshFactoryConfigs('p1');

    expect(result).toEqual({
      updatedCount: 1,
      totalWorkspaces: 3,
      errors: [{ workspaceId: 'w2', error: 'bad config' }],
    });
    expect(mockSyncWorkspaceCommandsFromWorktreeConfig).toHaveBeenCalledWith({
      workspaceId: 'w1',
      worktreePath: '/tmp/w1',
      persistWorkspaceCommands: expect.any(Function),
    });
    expect(mockSyncWorkspaceCommandsFromWorktreeConfig).toHaveBeenCalledWith({
      workspaceId: 'w2',
      worktreePath: '/tmp/w2',
      persistWorkspaceCommands: expect.any(Function),
    });
    expect(mockSyncWorkspaceCommandsFromWorktreeConfig).toHaveBeenCalledTimes(2);
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

  it('queries active workspaces by excluding ARCHIVING and ARCHIVED statuses', async () => {
    mockFindByProjectIdWithSessions.mockResolvedValue([]);
    mockProjectFindById.mockResolvedValue({ id: 'p1', defaultBranch: 'main' });
    mockGetAllPendingRequests.mockReturnValue(new Map());
    mockGithubCheckHealth.mockResolvedValue({ isInstalled: false, isAuthenticated: false });

    await workspaceQueryService.getProjectSummaryState('p1');
    await workspaceQueryService.listWithKanbanState({ projectId: 'p1' });
    await workspaceQueryService.syncAllPRStatuses('p1');

    expect(mockFindByProjectIdWithSessions).toHaveBeenNthCalledWith(1, 'p1', {
      excludeStatuses: [WorkspaceStatus.ARCHIVING, WorkspaceStatus.ARCHIVED],
    });
    expect(mockFindByProjectIdWithSessions).toHaveBeenNthCalledWith(2, 'p1', {
      excludeStatuses: [WorkspaceStatus.ARCHIVING, WorkspaceStatus.ARCHIVED],
    });
    expect(mockFindByProjectIdWithSessions).toHaveBeenNthCalledWith(3, 'p1', {
      excludeStatuses: [WorkspaceStatus.ARCHIVING, WorkspaceStatus.ARCHIVED],
    });
  });
});
