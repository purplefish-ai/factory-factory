import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceGitHubBridge,
  WorkspacePRSnapshotBridge,
  WorkspaceQuerySessionBridge,
  WorkspaceSessionBridge,
} from '@/backend/services/workspace/service/bridges';
import { WorkspaceSnapshotStore } from '@/backend/services/workspace/service/snapshot/workspace-snapshot-store.service';
import { deriveWorkspaceFlowState } from '@/backend/services/workspace/service/state/flow-state';
import { computeKanbanColumn } from '@/backend/services/workspace/service/state/kanban-state';
import {
  CIStatus,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  WorkspaceStatus,
} from '@/shared/core';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { workspaceQueryService } from './workspace-query.service';

const mockFindByProjectIdWithSessions = vi.fn();
const mockFindById = vi.fn();
const mockFindByIdWithProject = vi.fn();
const mockWorkspaceUpdate = vi.fn();
const mockResetPRDiscoveryBackoff = vi.fn();
const mockProjectFindById = vi.fn();
const mockDeriveWorkspaceRuntimeState = vi.fn();
const mockGetWorkspaceGitStats = vi.fn();

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    findByProjectIdWithSessions: (...args: unknown[]) => mockFindByProjectIdWithSessions(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    findByIdWithProject: (...args: unknown[]) => mockFindByIdWithProject(...args),
    update: (...args: unknown[]) => mockWorkspaceUpdate(...args),
  },
}));

vi.mock('@/backend/services/workspace/resources/workspace-pr.accessor', () => ({
  workspacePrAccessor: {
    resetDiscoveryBackoff: (...args: unknown[]) => mockResetPRDiscoveryBackoff(...args),
  },
}));

vi.mock('@/backend/services/workspace/resources/project.accessor', () => ({
  projectAccessor: {
    findById: (...args: unknown[]) => mockProjectFindById(...args),
  },
}));

vi.mock('@/backend/services/workspace/service/state/workspace-runtime-state', () => ({
  deriveWorkspaceRuntimeState: (...args: unknown[]) => mockDeriveWorkspaceRuntimeState(...args),
}));

vi.mock('@/backend/services/workspace/service/worktree/git-ops.service', () => ({
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
  const mockGetAllPendingRequests = vi.fn<WorkspaceSessionBridge['getAllPendingRequests']>();
  const mockGetRuntimeSnapshot = vi.fn<WorkspaceQuerySessionBridge['getRuntimeSnapshot']>();
  const mockSessionBridge: WorkspaceQuerySessionBridge = {
    getAllPendingRequests: mockGetAllPendingRequests,
    getRuntimeSnapshot: mockGetRuntimeSnapshot,
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
    mockGetRuntimeSnapshot.mockReturnValue({
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    workspaceQueryService.configure({
      session: mockSessionBridge,
      github: mockGithubBridge,
      prSnapshot: mockPrSnapshotBridge,
    });
  });

  it('listForProject applies runtime-derived reasons, newest first', async () => {
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'w1',
        status: WorkspaceStatus.READY,
        prUrl: null,
        prState: 'NONE',
        prCiStatus: 'UNKNOWN',
        ratchetState: 'IDLE',
        runScriptStatus: 'IDLE',
        hasHadSessions: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        agentSessions: [],
      },
      {
        id: 'w2',
        status: WorkspaceStatus.READY,
        prUrl: 'https://github.com/o/r/pull/2',
        prState: 'OPEN',
        prCiStatus: 'PENDING',
        ratchetState: 'REVIEW_PENDING',
        runScriptStatus: 'IDLE',
        hasHadSessions: true,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        agentSessions: [],
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
        phase: workspace.id === 'w2' ? 'CI_WAIT' : 'NO_PR',
        ciObservation: 'CHECKS_UNKNOWN',
      },
    }));
    mockGetAllPendingRequests.mockReturnValue(new Map([['w2', { toolName: 'AskUserQuestion' }]]));

    const { workspaces: result } = await workspaceQueryService.listForProject('proj-1');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 'w2',
      kanbanColumn: 'WAITING',
      pendingRequestType: 'user_question',
      ratchetButtonAnimated: true,
      flowPhase: 'CI_WAIT',
      statusReason: {
        code: 'NEEDS_ANSWER',
        label: 'Needs your answer',
      },
    });
    expect(result[1]).toMatchObject({
      id: 'w1',
      kanbanColumn: 'WAITING',
      statusReason: {
        code: 'NO_SESSION_STARTED',
        label: 'No session started',
      },
    });
  });

  it('keeps pending CI automation-owned without marking the session working', async () => {
    mockProjectFindById.mockResolvedValue({ id: 'p1', defaultBranch: 'main' });
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'w-ci',
        name: 'Pending CI',
        status: WorkspaceStatus.READY,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        worktreePath: null,
        branchName: 'feature/pending-ci',
        prUrl: 'https://github.com/org/repo/pull/1',
        prNumber: 1,
        prState: PRState.OPEN,
        prCiStatus: CIStatus.PENDING,
        prUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_RUNNING,
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
        runScriptStatus: RunScriptStatus.IDLE,
        hasHadSessions: true,
        agentSessions: [],
        terminalSessions: [],
      },
    ]);
    mockDeriveWorkspaceRuntimeState.mockReturnValue({
      sessionIds: [],
      isSessionWorking: false,
      isWorking: true,
      flowState: {
        hasActivePr: true,
        isWorking: true,
        shouldAnimateRatchetButton: true,
        phase: 'CI_WAIT',
        ciObservation: 'CHECKS_PENDING',
      },
    });
    mockGetAllPendingRequests.mockReturnValue(new Map());
    mockGithubCheckHealth.mockResolvedValue({ isInstalled: false, isAuthenticated: false });

    const result = await workspaceQueryService.listForProject('p1');

    expect(result.workspaces[0]).toMatchObject({
      id: 'w-ci',
      isWorking: false,
    });
  });

  it('findWorkspaceIdsInKanbanColumn returns only ids matching the live column', async () => {
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'w1',
        status: WorkspaceStatus.READY,
        prUrl: null,
        prState: PRState.NONE,
        prCiStatus: CIStatus.UNKNOWN,
        ratchetState: RatchetState.IDLE,
        runScriptStatus: RunScriptStatus.IDLE,
        hasHadSessions: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    mockDeriveWorkspaceRuntimeState.mockReturnValue({
      sessionIds: ['s-1'],
      isSessionWorking: true,
      isWorking: true,
      flowState: {
        hasActivePr: false,
        isWorking: true,
        shouldAnimateRatchetButton: false,
        phase: 'NO_PR',
        ciObservation: 'CHECKS_UNKNOWN',
      },
    });
    mockGetAllPendingRequests.mockReturnValue(new Map());

    const result = await workspaceQueryService.findWorkspaceIdsInKanbanColumn(
      'proj-1',
      KanbanColumn.WAITING
    );

    expect(result).toEqual([]);
    expect(mockFindByProjectIdWithSessions).toHaveBeenCalledWith('proj-1', {
      excludeStatuses: [WorkspaceStatus.ARCHIVING, WorkspaceStatus.ARCHIVED],
    });
  });

  it('treats an alive-but-idle session as working, matching the snapshot store', async () => {
    // hasWorkingSessionSummary is true for runtimePhase 'running' even when no
    // prompt is in flight. The snapshot store and reconciliation use that
    // predicate, so this query must too — a narrower one (prompt-in-flight
    // only) would report WAITING here while the live board reported WORKING.
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'w-alive',
        status: WorkspaceStatus.READY,
        prUrl: null,
        prState: PRState.NONE,
        prCiStatus: CIStatus.UNKNOWN,
        ratchetState: RatchetState.IDLE,
        runScriptStatus: RunScriptStatus.IDLE,
        hasHadSessions: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        agentSessions: [
          { id: 's-alive', name: null, workflow: null, model: null, status: 'ACTIVE' },
        ],
      },
    ]);
    mockGetRuntimeSnapshot.mockReturnValue({
      phase: 'running',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    // Let the service's own predicate decide, rather than stubbing the answer.
    mockDeriveWorkspaceRuntimeState.mockImplementation(
      (
        workspace: { id: string },
        resolveSessionWorking: (ids: string[], id: string) => boolean
      ) => {
        const isSessionWorking = resolveSessionWorking(['s-alive'], workspace.id);
        return {
          sessionIds: ['s-alive'],
          isSessionWorking,
          isWorking: isSessionWorking,
          flowState: {
            hasActivePr: false,
            isWorking: false,
            shouldAnimateRatchetButton: false,
            phase: 'NO_PR',
            ciObservation: 'CHECKS_UNKNOWN',
          },
        };
      }
    );
    mockGetAllPendingRequests.mockReturnValue(new Map());

    const { workspaces: result } = await workspaceQueryService.listForProject('proj-1');

    expect(result[0]).toMatchObject({ id: 'w-alive', kanbanColumn: 'WORKING', isWorking: true });
  });

  it('findWorkspaceIdsInKanbanColumn matches a column only live session state produces', async () => {
    // A READY workspace with no PR is WAITING by its persisted fields alone; it
    // is WORKING only because a session is live. Filtering used to run against
    // the persisted cachedKanbanColumn in SQL, which dropped this workspace
    // from the result (and so from bulk archive) before derivation ever ran.
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'w-live',
        status: WorkspaceStatus.READY,
        prUrl: null,
        prState: PRState.NONE,
        prCiStatus: CIStatus.UNKNOWN,
        ratchetState: RatchetState.IDLE,
        runScriptStatus: RunScriptStatus.IDLE,
        hasHadSessions: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    mockDeriveWorkspaceRuntimeState.mockReturnValue({
      sessionIds: ['s-1'],
      isSessionWorking: true,
      isWorking: true,
      flowState: {
        hasActivePr: false,
        isWorking: false,
        shouldAnimateRatchetButton: false,
        phase: 'NO_PR',
        ciObservation: 'CHECKS_UNKNOWN',
      },
    });
    mockGetAllPendingRequests.mockReturnValue(new Map());

    const result = await workspaceQueryService.findWorkspaceIdsInKanbanColumn(
      'proj-1',
      KanbanColumn.WORKING
    );

    expect(result).toEqual(['w-live']);
    expect(mockFindByProjectIdWithSessions).toHaveBeenCalledWith('proj-1', {
      excludeStatuses: [WorkspaceStatus.ARCHIVING, WorkspaceStatus.ARCHIVED],
    });
  });

  it('findWorkspaceIdsInKanbanColumn returns FAILED workspaces for WAITING', async () => {
    mockFindByProjectIdWithSessions.mockResolvedValue([
      {
        id: 'w1',
        status: WorkspaceStatus.FAILED,
        prUrl: null,
        prState: PRState.NONE,
        prCiStatus: CIStatus.UNKNOWN,
        ratchetState: RatchetState.IDLE,
        runScriptStatus: RunScriptStatus.IDLE,
        hasHadSessions: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    mockDeriveWorkspaceRuntimeState.mockReturnValue({
      sessionIds: [],
      isSessionWorking: false,
      isWorking: false,
      flowState: {
        hasActivePr: false,
        isWorking: false,
        shouldAnimateRatchetButton: false,
        phase: 'NO_PR',
        ciObservation: 'CHECKS_UNKNOWN',
      },
    });
    mockGetAllPendingRequests.mockReturnValue(new Map());

    const result = await workspaceQueryService.findWorkspaceIdsInKanbanColumn(
      'proj-1',
      KanbanColumn.WAITING
    );

    expect(result).toEqual(['w1']);
    expect(mockFindByProjectIdWithSessions).toHaveBeenCalledWith('proj-1', {
      excludeStatuses: [WorkspaceStatus.ARCHIVING, WorkspaceStatus.ARCHIVED],
    });
  });

  it('surfaces session runtime errors in the initial workspace query', async () => {
    const erroredWorkspace = {
      id: 'w1',
      name: 'W1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      worktreePath: null,
      branchName: null,
      prUrl: null,
      prNumber: null,
      prState: PRState.NONE,
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: false,
      ratchetState: RatchetState.IDLE,
      runScriptStatus: RunScriptStatus.IDLE,
      hasHadSessions: true,
      agentSessions: [
        {
          id: 's1',
          name: null,
          workflow: null,
          model: null,
          status: 'FAILED',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      terminalSessions: [],
    };

    mockProjectFindById.mockResolvedValue({ id: 'p1', defaultBranch: 'main' });
    mockFindByProjectIdWithSessions.mockResolvedValue([erroredWorkspace]);
    mockDeriveWorkspaceRuntimeState.mockReturnValue({
      sessionIds: ['s1'],
      isSessionWorking: false,
      isWorking: false,
      flowState: {
        hasActivePr: false,
        isWorking: false,
        shouldAnimateRatchetButton: false,
        phase: 'NO_PR',
        ciObservation: 'CHECKS_UNKNOWN',
      },
    });
    mockGetRuntimeSnapshot.mockReturnValue({
      phase: 'error',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-01-01T00:00:00.000Z',
      errorMessage: 'Session crashed',
    });
    mockGetAllPendingRequests.mockReturnValue(new Map());
    mockGithubCheckHealth.mockResolvedValue({ isInstalled: false, isAuthenticated: false });

    const { workspaces } = await workspaceQueryService.listForProject('p1');

    expect(workspaces[0]?.statusReason).toMatchObject({
      code: 'SESSION_ERROR',
      label: 'Session error',
    });
  });

  it('listForProject computes git stats and caches review count', async () => {
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
        hasHadSessions: true,
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
        phase: workspace.id === 'w2' ? 'CI_WAIT' : 'NO_PR',
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

    // First call: no cache yet — returns 0 immediately and fires background refresh.
    const first = await workspaceQueryService.listForProject('p1');
    expect(first.reviewCount).toBe(0);
    // Newest first, so every surface renders the same order without re-sorting.
    expect(first.workspaces.map((workspace) => workspace.id)).toEqual(['w2', 'w1']);
    expect(first.workspaces[1]).toMatchObject({
      id: 'w1',
      isWorking: false,
      gitStats: expect.objectContaining({ total: 3 }),
      lastActivityAt: '2026-01-03T00:00:00.000Z',
    });
    expect(first.workspaces[0]).toMatchObject({
      id: 'w2',
      gitStats: null,
      lastActivityAt: '2026-01-04T00:00:00.000Z',
    });
    expect(mockGetWorkspaceGitStats).toHaveBeenCalledWith('/tmp/w1', 'main');

    // Flush background refresh promises (checkHealth → listReviewRequests → cache write).
    await new Promise((resolve) => setImmediate(resolve));

    // Second call: cache is now warm — returns cached count without calling GitHub.
    mockGithubListReviewRequests.mockClear();
    const second = await workspaceQueryService.listForProject('p1');
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
      isWorking: false,
      flowState,
    });

    const listed = await workspaceQueryService.listForProject('p1');
    const listedWorkspace = listed.workspaces[0];

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
    expect(listedWorkspace).toBeDefined();

    expect(listedWorkspace?.flowPhase).toBe(snapshotEntry?.flowPhase);
    expect(listedWorkspace?.ciObservation).toBe(snapshotEntry?.ciObservation);
    expect(listedWorkspace?.sidebarStatus).toEqual(snapshotEntry?.sidebarStatus);
    expect(listedWorkspace?.kanbanColumn).toBe(snapshotEntry?.kanbanColumn);
    expect(listedWorkspace?.statusReason).toEqual(snapshotEntry?.statusReason);
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
      queued: 0,
    });

    mockFindByProjectIdWithSessions.mockResolvedValueOnce([
      { id: 'w1', prUrl: 'https://github.com/o/r/pull/1' },
      { id: 'w2', prUrl: 'https://github.com/o/r/pull/2' },
    ]);
    mockRefreshWorkspace
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });

    await expect(workspaceQueryService.syncAllPRStatuses('p1')).resolves.toEqual({
      queued: 2,
    });
  });

  it('syncPRStatus resets discovery backoff before returning no_pr_url', async () => {
    mockFindById.mockResolvedValue({ id: 'w1', prUrl: null });
    mockResetPRDiscoveryBackoff.mockResolvedValue(true);

    await expect(workspaceQueryService.syncPRStatus('w1')).resolves.toEqual({
      success: false,
      reason: 'no_pr_url',
    });

    expect(mockResetPRDiscoveryBackoff).toHaveBeenCalledOnce();
    expect(mockResetPRDiscoveryBackoff).toHaveBeenCalledWith('w1');
    expect(mockRefreshWorkspace).not.toHaveBeenCalled();
  });

  it('syncAllPRStatuses does not reset discovery backoff for workspaces without PRs', async () => {
    mockFindByProjectIdWithSessions.mockResolvedValue([
      { id: 'w1', prUrl: null },
      { id: 'w2', prUrl: null },
    ]);

    await expect(workspaceQueryService.syncAllPRStatuses('p1')).resolves.toEqual({ queued: 0 });

    expect(mockResetPRDiscoveryBackoff).not.toHaveBeenCalled();
  });

  it('skips concurrent syncAllPRStatuses calls while the workspace lookup is pending', async () => {
    let resolveLookup:
      | ((workspaces: Array<{ id: string; prUrl: string | null }>) => void)
      | undefined;
    const lookupPromise = new Promise<Array<{ id: string; prUrl: string | null }>>((resolve) => {
      resolveLookup = resolve;
    });

    mockFindByProjectIdWithSessions.mockReturnValueOnce(lookupPromise);
    mockRefreshWorkspace.mockResolvedValueOnce({ success: true });

    const firstSync = workspaceQueryService.syncAllPRStatuses('p1');
    await Promise.resolve();

    await expect(workspaceQueryService.syncAllPRStatuses('p1')).resolves.toEqual({ queued: 0 });
    expect(mockFindByProjectIdWithSessions).toHaveBeenCalledTimes(1);

    resolveLookup?.([{ id: 'w1', prUrl: 'https://github.com/o/r/pull/1' }]);
    await expect(firstSync).resolves.toEqual({ queued: 1 });
    await vi.waitFor(() => {
      expect(mockRefreshWorkspace).toHaveBeenCalledTimes(1);
    });
  });

  it('runs syncAllPRStatuses independently for different projects', async () => {
    let resolveFirstRefresh: ((result: { success: boolean }) => void) | undefined;
    const firstRefresh = new Promise<{ success: boolean }>((resolve) => {
      resolveFirstRefresh = resolve;
    });

    mockFindByProjectIdWithSessions.mockImplementation(async (projectId: string) => [
      {
        id: projectId === 'p1' ? 'w1' : 'w2',
        prUrl: `https://github.com/o/r/pull/${projectId === 'p1' ? '1' : '2'}`,
      },
    ]);
    mockRefreshWorkspace.mockImplementation((workspaceId: string) =>
      workspaceId === 'w1' ? firstRefresh : Promise.resolve({ success: true })
    );

    try {
      await expect(workspaceQueryService.syncAllPRStatuses('p1')).resolves.toEqual({ queued: 1 });
      await vi.waitFor(() => {
        expect(mockRefreshWorkspace).toHaveBeenCalledWith('w1', 'https://github.com/o/r/pull/1');
      });

      await expect(workspaceQueryService.syncAllPRStatuses('p2')).resolves.toEqual({ queued: 1 });
      expect(mockFindByProjectIdWithSessions).toHaveBeenCalledWith('p2', {
        excludeStatuses: [WorkspaceStatus.ARCHIVING, WorkspaceStatus.ARCHIVED],
      });
      await vi.waitFor(() => {
        expect(mockRefreshWorkspace).toHaveBeenCalledWith('w2', 'https://github.com/o/r/pull/2');
      });
    } finally {
      resolveFirstRefresh?.({ success: true });
      await firstRefresh;
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it('hasChanges checks workspace metadata and git stats safely', async () => {
    mockFindByIdWithProject.mockResolvedValueOnce(null);
    await expect(workspaceQueryService.hasChanges('w1')).resolves.toBe(false);
    expect(mockGetWorkspaceGitStats).not.toHaveBeenCalled();

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
    expect(mockGetWorkspaceGitStats).toHaveBeenLastCalledWith('/tmp/w1', 'main');

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
    expect(mockGetWorkspaceGitStats).toHaveBeenLastCalledWith('/tmp/w1', 'main');

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

    await workspaceQueryService.listForProject('p1');
    await workspaceQueryService.findWorkspaceIdsInKanbanColumn('p1', KanbanColumn.WORKING);
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
