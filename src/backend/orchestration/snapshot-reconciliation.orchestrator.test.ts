import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_THRESHOLDS } from '@/backend/services/constants';
import type { SnapshotUpdateInput, WorkspaceSnapshotEntry } from '@/backend/services/workspace';
import { computeKanbanColumn, deriveWorkspaceFlowState } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import type { SessionRuntimeState } from '@/shared/session-runtime';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockFindAllNonArchived = vi.fn();
const mockGetWorkspaceGitStats = vi.fn();
const mockUpsert = vi.fn();
const mockGetByWorkspaceId = vi.fn();
const mockGetAllWorkspaceIds = vi.fn().mockReturnValue([]);
const mockRemove = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('@/backend/services/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/services/workspace')>();
  return {
    ...actual,
    workspaceAccessor: {
      findAllNonArchivedWithSessionsAndProject: (...args: unknown[]) =>
        mockFindAllNonArchived(...args),
    },
    gitOpsService: {
      getWorkspaceGitStats: (...args: unknown[]) => mockGetWorkspaceGitStats(...args),
    },
    workspaceSnapshotStore: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      getByWorkspaceId: (...args: unknown[]) => mockGetByWorkspaceId(...args),
      getAllWorkspaceIds: () => mockGetAllWorkspaceIds(),
      remove: (...args: unknown[]) => mockRemove(...args),
    },
  };
});

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    debug: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  }),
}));

vi.mock('@/backend/services/session', () => ({
  sessionService: { getRuntimeSnapshot: vi.fn() },
  chatEventForwarderService: { getAllPendingRequests: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  detectDrift,
  type ReconciliationBridges,
  SnapshotReconciliationService,
} from './snapshot-reconciliation.orchestrator';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockWorkspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ws-1',
    projectId: 'proj-1',
    name: 'Test Workspace',
    status: 'READY',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    branchName: 'feature/test',
    hasHadSessions: true,
    worktreePath: '/path/to/worktree',
    prUrl: 'https://github.com/org/repo/pull/1',
    prNumber: 1,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
    prUpdatedAt: new Date('2026-01-02T00:00:00Z'),
    ratchetEnabled: true,
    ratchetState: 'IDLE',
    ratchetDispatchOutcome: 'DIED',
    ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
    runScriptStatus: 'IDLE',
    agentSessions: [
      {
        id: 'cs-1',
        name: 'Chat 1',
        workflow: 'followup',
        model: 'claude-sonnet',
        status: 'IDLE',
        updatedAt: new Date('2026-01-03T10:00:00Z'),
      },
      {
        id: 'cs-2',
        name: 'Chat 2',
        workflow: 'followup',
        model: 'claude-sonnet',
        status: 'IDLE',
        updatedAt: new Date('2026-01-03T12:00:00Z'),
      },
    ],
    terminalSessions: [{ id: 'ts-1', updatedAt: new Date('2026-01-03T11:00:00Z') }],
    project: { defaultBranch: 'main' },
    ...overrides,
  };
}

function createMockBridges(): ReconciliationBridges {
  const runtime: SessionRuntimeState = {
    phase: 'idle',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt: '2026-01-03T12:00:00.000Z',
  };
  return {
    session: {
      getRuntimeSnapshot: vi.fn().mockReturnValue(runtime),
      getAllPendingRequests: vi.fn().mockReturnValue(new Map()),
    },
  };
}

function createSnapshotEntry(
  overrides: Partial<WorkspaceSnapshotEntry> = {}
): WorkspaceSnapshotEntry {
  return {
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    version: 1,
    computedAt: '2026-01-01T00:00:00Z',
    source: 'reconciliation',
    name: 'Test Workspace',
    status: 'READY',
    createdAt: '2026-01-01T00:00:00Z',
    branchName: 'feature/test',
    prUrl: 'https://github.com/org/repo/pull/1',
    prNumber: 1,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
    prUpdatedAt: '2026-01-02T00:00:00Z',
    ratchetEnabled: true,
    ratchetState: 'IDLE',
    ratchetDispatchOutcome: 'DIED',
    ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
    runScriptStatus: 'IDLE',
    hasHadSessions: true,
    isWorking: false,
    pendingRequestType: null,
    sessionSummaries: [],
    gitStats: null,
    lastActivityAt: null,
    sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
    kanbanColumn: 'WAITING',
    flowPhase: 'NO_PR',
    ciObservation: 'NOT_FETCHED',
    ratchetButtonAnimated: false,
    fieldTimestamps: {
      workspace: 0,
      pr: 0,
      session: 0,
      ratchet: 0,
      runScript: 0,
      reconciliation: 0,
    },
    ...overrides,
  } as WorkspaceSnapshotEntry;
}

// ---------------------------------------------------------------------------
// Tests: detectDrift (pure function)
// ---------------------------------------------------------------------------

describe('detectDrift', () => {
  it('returns empty array when all fields match', () => {
    const existing = createSnapshotEntry({ status: 'READY', prState: 'OPEN' });
    const authoritative: SnapshotUpdateInput = { status: 'READY', prState: 'OPEN' };

    const result = detectDrift(existing, authoritative);

    expect(result).toEqual([]);
  });

  it('detects workspace field drift', () => {
    const existing = createSnapshotEntry({ status: 'NEW' });
    const authoritative: SnapshotUpdateInput = { status: 'READY' };

    const result = detectDrift(existing, authoritative);

    expect(result).toEqual([
      {
        field: 'status',
        group: 'workspace',
        snapshotValue: 'NEW',
        authoritativeValue: 'READY',
      },
    ]);
  });

  it('detects PR field drift', () => {
    const existing = createSnapshotEntry({
      prState: 'OPEN',
      prCiStatus: 'UNKNOWN',
    });
    const authoritative: SnapshotUpdateInput = {
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
    };

    const result = detectDrift(existing, authoritative);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      field: 'prState',
      group: 'pr',
      snapshotValue: 'OPEN',
      authoritativeValue: 'MERGED',
    });
    expect(result).toContainEqual({
      field: 'prCiStatus',
      group: 'pr',
      snapshotValue: 'UNKNOWN',
      authoritativeValue: 'SUCCESS',
    });
  });

  it('detects session field drift', () => {
    const existing = createSnapshotEntry({ isWorking: false });
    const authoritative: SnapshotUpdateInput = { isWorking: true };

    const result = detectDrift(existing, authoritative);

    expect(result).toEqual([
      {
        field: 'isWorking',
        group: 'session',
        snapshotValue: false,
        authoritativeValue: true,
      },
    ]);
  });

  it.each([
    {
      field: 'ratchetDispatchOutcome' as const,
      snapshotValue: 'RUNNING' as const,
      authoritativeValue: 'DIED' as const,
    },
    {
      field: 'ratchetDispatchRetryCount' as const,
      snapshotValue: 1,
      authoritativeValue: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
    },
  ])('detects Ratchet drift when $field changes', (drift) => {
    const existing = createSnapshotEntry({ [drift.field]: drift.snapshotValue });
    const authoritative: SnapshotUpdateInput = {
      [drift.field]: drift.authoritativeValue,
    };

    expect(detectDrift(existing, authoritative)).toEqual([
      {
        field: drift.field,
        group: 'ratchet',
        snapshotValue: drift.snapshotValue,
        authoritativeValue: drift.authoritativeValue,
      },
    ]);
  });

  it('ignores undefined authoritative fields', () => {
    const existing = createSnapshotEntry({ status: 'NEW', prState: 'OPEN' });
    const authoritative: SnapshotUpdateInput = { status: 'READY' };
    // prState is undefined in authoritative, should not compare it

    const result = detectDrift(existing, authoritative);

    expect(result).toHaveLength(1);
    expect(result[0]?.field).toBe('status');
  });

  it('detects multiple drifts across groups', () => {
    const existing = createSnapshotEntry({
      status: 'NEW',
      prState: 'NONE',
      isWorking: false,
    });
    const authoritative: SnapshotUpdateInput = {
      status: 'READY',
      prState: 'OPEN',
      isWorking: true,
    };

    const result = detectDrift(existing, authoritative);

    expect(result).toHaveLength(3);
    const groups = result.map((d) => d.group);
    expect(groups).toContain('workspace');
    expect(groups).toContain('pr');
    expect(groups).toContain('session');
  });
});

// ---------------------------------------------------------------------------
// Tests: SnapshotReconciliationService
// ---------------------------------------------------------------------------

describe('SnapshotReconciliationService', () => {
  let service: SnapshotReconciliationService;
  let bridges: ReconciliationBridges;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SnapshotReconciliationService();
    bridges = createMockBridges();
    service.configure(bridges);

    // Default: no workspaces, no stale entries
    mockFindAllNonArchived.mockResolvedValue([]);
    mockGetAllWorkspaceIds.mockReturnValue([]);
    mockGetByWorkspaceId.mockReturnValue(undefined);
    mockUpsert.mockReturnValue({ accepted: true, changed: true, emitted: true });
    mockRemove.mockReturnValue(true);
  });

  afterEach(async () => {
    await service.stop();
  });

  describe('reconcile()', () => {
    it('upserts all non-archived workspaces with authoritative data', async () => {
      const ws1 = createMockWorkspace({ id: 'ws-1' });
      const ws2 = createMockWorkspace({
        id: 'ws-2',
        name: 'Second Workspace',
        worktreePath: null,
      });
      mockFindAllNonArchived.mockResolvedValue([ws1, ws2]);
      mockGetWorkspaceGitStats.mockResolvedValue({
        total: 5,
        additions: 3,
        deletions: 2,
        hasUncommitted: false,
      });

      await service.reconcile();

      expect(mockUpsert).toHaveBeenCalledTimes(2);

      // Verify first workspace's upsert contains correct fields
      const firstCall = mockUpsert.mock.calls[0]!;
      expect(firstCall[0]).toBe('ws-1');
      const fields = firstCall[1]! as SnapshotUpdateInput;
      expect(fields.name).toBe('Test Workspace');
      expect(fields.status).toBe('READY');
      expect(fields.projectId).toBe('proj-1');
      expect(fields.branchName).toBe('feature/test');
      expect(fields.prState).toBe('OPEN');
      expect(fields.ratchetEnabled).toBe(true);
      expect(fields.ratchetDispatchOutcome).toBe('DIED');
      expect(fields.ratchetDispatchRetryCount).toBe(SERVICE_THRESHOLDS.ratchetDispatchMaxRetries);

      const { WorkspaceSnapshotStore } = await vi.importActual<
        typeof import('@/backend/services/workspace')
      >('@/backend/services/workspace');
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
      snapshotStore.upsert('ws-1', fields, 'reconciliation', 100);
      const snapshot = snapshotStore.getByWorkspaceId('ws-1');
      expect(snapshot).toMatchObject({
        ratchetDispatchOutcome: 'DIED',
        ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
        kanbanColumn: 'WAITING',
      });

      // Verify second workspace was also upserted
      const secondCall = mockUpsert.mock.calls[1]!;
      expect(secondCall[0]).toBe('ws-2');
    });

    it('passes pollStartTs to every upsert call (RCNL-03)', async () => {
      const ws1 = createMockWorkspace({ id: 'ws-1', worktreePath: null });
      const ws2 = createMockWorkspace({ id: 'ws-2', worktreePath: null });
      mockFindAllNonArchived.mockResolvedValue([ws1, ws2]);

      const beforeTs = Date.now();
      await service.reconcile();
      const afterTs = Date.now();

      expect(mockUpsert).toHaveBeenCalledTimes(2);

      // Both calls should have the same pollStartTs (4th argument)
      const ts1 = mockUpsert.mock.calls[0]![3] as number;
      const ts2 = mockUpsert.mock.calls[1]![3] as number;
      expect(ts1).toBe(ts2);
      expect(ts1).toBeGreaterThanOrEqual(beforeTs);
      expect(ts1).toBeLessThanOrEqual(afterTs);

      // Source should be 'reconciliation'
      expect(mockUpsert.mock.calls[0]![2]).toBe('reconciliation');
      expect(mockUpsert.mock.calls[1]![2]).toBe('reconciliation');
    });

    it('computes git stats only for workspaces with worktreePath', async () => {
      const wsWithPath = createMockWorkspace({
        id: 'ws-1',
        worktreePath: '/path/to/worktree',
      });
      const wsWithoutPath = createMockWorkspace({
        id: 'ws-2',
        worktreePath: null,
      });
      mockFindAllNonArchived.mockResolvedValue([wsWithPath, wsWithoutPath]);
      mockGetWorkspaceGitStats.mockResolvedValue({
        total: 5,
        additions: 3,
        deletions: 2,
        hasUncommitted: false,
      });

      await service.reconcile();

      expect(mockGetWorkspaceGitStats).toHaveBeenCalledTimes(1);
      expect(mockGetWorkspaceGitStats).toHaveBeenCalledWith('/path/to/worktree', 'main');
    });

    it('uses project defaultBranch for git stats', async () => {
      const ws = createMockWorkspace({
        id: 'ws-1',
        worktreePath: '/path/to/worktree',
        project: { defaultBranch: 'develop' },
      });
      mockFindAllNonArchived.mockResolvedValue([ws]);
      mockGetWorkspaceGitStats.mockResolvedValue({
        total: 1,
        additions: 1,
        deletions: 0,
        hasUncommitted: false,
      });

      await service.reconcile();

      expect(mockGetWorkspaceGitStats).toHaveBeenCalledWith('/path/to/worktree', 'develop');
    });

    it('handles git stats errors gracefully', async () => {
      const ws = createMockWorkspace({
        id: 'ws-1',
        worktreePath: '/path/to/worktree',
      });
      mockFindAllNonArchived.mockResolvedValue([ws]);
      mockGetWorkspaceGitStats.mockRejectedValue(new Error('git error'));

      const result = await service.reconcile();

      // Should not throw, gitStats should be null
      expect(result.gitStatsComputed).toBe(0);
      const upsertFields = mockUpsert.mock.calls[0]![1] as SnapshotUpdateInput;
      expect(upsertFields.gitStats).toBeNull();
    });

    it('detects drift for existing entries (RCNL-04)', async () => {
      const ws = createMockWorkspace({
        id: 'ws-1',
        status: 'READY',
        worktreePath: null,
      });
      mockFindAllNonArchived.mockResolvedValue([ws]);

      // Existing entry has different status
      mockGetByWorkspaceId.mockReturnValue(createSnapshotEntry({ status: 'NEW' }));

      await service.reconcile();

      // logger.warn should have been called with drift info
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Snapshot drift detected',
        expect.objectContaining({
          workspaceId: 'ws-1',
          driftCount: expect.any(Number),
          drifts: expect.arrayContaining([expect.objectContaining({ field: 'status' })]),
        })
      );
    });

    it('skips drift detection for new entries (no log spam on first run)', async () => {
      const ws = createMockWorkspace({ id: 'ws-1', worktreePath: null });
      mockFindAllNonArchived.mockResolvedValue([ws]);
      mockGetByWorkspaceId.mockReturnValue(undefined);

      await service.reconcile();

      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it('removes stale entries not in DB', async () => {
      // DB has only ws-1
      mockFindAllNonArchived.mockResolvedValue([
        createMockWorkspace({ id: 'ws-1', worktreePath: null }),
      ]);

      // Store has ws-1 and ws-2 (ws-2 is stale)
      mockGetAllWorkspaceIds.mockReturnValue(['ws-1', 'ws-2']);

      const result = await service.reconcile();

      expect(mockRemove).toHaveBeenCalledWith('ws-2');
      expect(mockRemove).toHaveBeenCalledTimes(1);
      expect(result.staleEntriesRemoved).toBe(1);
    });

    it('computes lastActivityAt from session timestamps', async () => {
      const ws = createMockWorkspace({
        id: 'ws-1',
        worktreePath: null,
        agentSessions: [
          {
            id: 'cs-1',
            name: 'Chat 1',
            workflow: 'followup',
            model: 'claude-sonnet',
            status: 'IDLE',
            updatedAt: new Date('2026-01-03T10:00:00Z'),
          },
          {
            id: 'cs-2',
            name: 'Chat 2',
            workflow: 'followup',
            model: 'claude-sonnet',
            status: 'IDLE',
            updatedAt: new Date('2026-01-03T14:00:00Z'),
          },
        ],
        terminalSessions: [{ id: 'ts-1', updatedAt: new Date('2026-01-03T12:00:00Z') }],
      });
      mockFindAllNonArchived.mockResolvedValue([ws]);

      await service.reconcile();

      const upsertFields = mockUpsert.mock.calls[0]![1] as SnapshotUpdateInput;
      // Latest session date is cs-2 at 14:00:00Z
      expect(upsertFields.lastActivityAt).toBe('2026-01-03T14:00:00.000Z');
    });

    it('computes pendingRequestType from session bridges', async () => {
      const ws = createMockWorkspace({
        id: 'ws-1',
        worktreePath: null,
        agentSessions: [
          {
            id: 'cs-1',
            name: 'Chat 1',
            workflow: 'followup',
            model: 'claude-sonnet',
            status: 'IDLE',
            updatedAt: new Date(),
          },
        ],
      });
      mockFindAllNonArchived.mockResolvedValue([ws]);

      // Set up pending requests with ExitPlanMode
      const pendingRequests = new Map([['cs-1', { toolName: 'ExitPlanMode' }]]);
      vi.mocked(bridges.session.getAllPendingRequests).mockReturnValue(pendingRequests);

      await service.reconcile();

      const upsertFields = mockUpsert.mock.calls[0]![1] as SnapshotUpdateInput;
      expect(upsertFields.pendingRequestType).toBe('plan_approval');
    });

    it('maps non-question permissions to permission_request', async () => {
      const ws = createMockWorkspace({
        id: 'ws-1',
        worktreePath: null,
        agentSessions: [
          {
            id: 'cs-1',
            name: 'Chat 1',
            workflow: 'followup',
            model: 'claude-sonnet',
            status: 'IDLE',
            updatedAt: new Date(),
          },
        ],
      });
      mockFindAllNonArchived.mockResolvedValue([ws]);

      const pendingRequests = new Map([['cs-1', { toolName: 'RequestPermission' }]]);
      vi.mocked(bridges.session.getAllPendingRequests).mockReturnValue(pendingRequests);

      await service.reconcile();

      const upsertFields = mockUpsert.mock.calls[0]![1] as SnapshotUpdateInput;
      expect(upsertFields.pendingRequestType).toBe('permission_request');
    });

    it('prioritizes AskUserQuestion over generic permissions when both are pending', async () => {
      const ws = createMockWorkspace({
        id: 'ws-1',
        worktreePath: null,
        agentSessions: [
          {
            id: 'cs-permission',
            name: 'Permission Session',
            workflow: 'followup',
            model: 'claude-sonnet',
            status: 'IDLE',
            updatedAt: new Date(),
          },
          {
            id: 'cs-question',
            name: 'Question Session',
            workflow: 'followup',
            model: 'claude-sonnet',
            status: 'IDLE',
            updatedAt: new Date(),
          },
        ],
      });
      mockFindAllNonArchived.mockResolvedValue([ws]);

      const pendingRequests = new Map([
        ['cs-permission', { toolName: 'RequestPermission' }],
        ['cs-question', { toolName: 'AskUserQuestion' }],
      ]);
      vi.mocked(bridges.session.getAllPendingRequests).mockReturnValue(pendingRequests);

      await service.reconcile();

      const upsertFields = mockUpsert.mock.calls[0]![1] as SnapshotUpdateInput;
      expect(upsertFields.pendingRequestType).toBe('user_question');
    });

    it('prioritizes ExitPlanMode over question and generic permissions', async () => {
      const ws = createMockWorkspace({
        id: 'ws-1',
        worktreePath: null,
        agentSessions: [
          {
            id: 'cs-permission',
            name: 'Permission Session',
            workflow: 'followup',
            model: 'claude-sonnet',
            status: 'IDLE',
            updatedAt: new Date(),
          },
          {
            id: 'cs-question',
            name: 'Question Session',
            workflow: 'followup',
            model: 'claude-sonnet',
            status: 'IDLE',
            updatedAt: new Date(),
          },
          {
            id: 'cs-plan',
            name: 'Plan Session',
            workflow: 'followup',
            model: 'claude-sonnet',
            status: 'IDLE',
            updatedAt: new Date(),
          },
        ],
      });
      mockFindAllNonArchived.mockResolvedValue([ws]);

      const pendingRequests = new Map([
        ['cs-permission', { toolName: 'RequestPermission' }],
        ['cs-question', { toolName: 'AskUserQuestion' }],
        ['cs-plan', { toolName: 'ExitPlanMode' }],
      ]);
      vi.mocked(bridges.session.getAllPendingRequests).mockReturnValue(pendingRequests);

      await service.reconcile();

      const upsertFields = mockUpsert.mock.calls[0]![1] as SnapshotUpdateInput;
      expect(upsertFields.pendingRequestType).toBe('plan_approval');
    });

    it('includes sessionSummaries derived from runtime snapshots', async () => {
      const ws = createMockWorkspace({
        id: 'ws-1',
        worktreePath: null,
      });
      mockFindAllNonArchived.mockResolvedValue([ws]);
      vi.mocked(bridges.session.getRuntimeSnapshot).mockReturnValue({
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
        updatedAt: '2026-01-03T15:00:00.000Z',
      });

      await service.reconcile();

      const upsertFields = mockUpsert.mock.calls[0]![1] as SnapshotUpdateInput;
      expect(upsertFields.sessionSummaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'cs-1',
            runtimePhase: 'running',
            activity: 'WORKING',
          }),
        ])
      );
      expect(upsertFields.isWorking).toBe(true);
    });

    it('does not treat stale persisted RUNNING sessions as working after restart', async () => {
      const ws = createMockWorkspace({
        id: 'ws-1',
        worktreePath: null,
        agentSessions: [
          {
            id: 'cs-stale',
            name: 'Stale Chat',
            workflow: 'followup',
            model: 'claude-sonnet',
            status: 'RUNNING',
            updatedAt: new Date('2026-01-03T15:00:00.000Z'),
          },
        ],
      });
      mockFindAllNonArchived.mockResolvedValue([ws]);
      vi.mocked(bridges.session.getRuntimeSnapshot).mockReturnValue({
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: '2026-01-03T15:00:00.000Z',
      });

      await service.reconcile();

      const upsertFields = mockUpsert.mock.calls[0]![1] as SnapshotUpdateInput;
      expect(upsertFields.sessionSummaries).toEqual([
        expect.objectContaining({
          sessionId: 'cs-stale',
          persistedStatus: 'RUNNING',
          runtimePhase: 'idle',
          activity: 'IDLE',
        }),
      ]);
      expect(upsertFields.isWorking).toBe(false);
    });

    it('returns ReconciliationResult with correct counts', async () => {
      const ws1 = createMockWorkspace({
        id: 'ws-1',
        worktreePath: '/path/1',
      });
      const ws2 = createMockWorkspace({
        id: 'ws-2',
        worktreePath: null,
      });
      mockFindAllNonArchived.mockResolvedValue([ws1, ws2]);
      mockGetWorkspaceGitStats.mockResolvedValue({
        total: 5,
        additions: 3,
        deletions: 2,
        hasUncommitted: false,
      });

      // ws-1 has existing entry with drift
      mockGetByWorkspaceId.mockImplementation((id: string) => {
        if (id === 'ws-1') {
          return createSnapshotEntry({ status: 'NEW' });
        }
        return undefined;
      });

      // One stale entry (ws-stale)
      mockGetAllWorkspaceIds.mockReturnValue(['ws-1', 'ws-2', 'ws-stale']);

      const result = await service.reconcile();

      expect(result.workspacesScanned).toBe(2);
      expect(result.workspacesChanged).toBe(2);
      expect(result.deltasEmitted).toBe(3);
      expect(result.workspacesReconciled).toBe(2);
      expect(result.driftsDetected).toBeGreaterThan(0);
      expect(result.staleEntriesRemoved).toBe(1);
      expect(result.gitStatsComputed).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        'Reconciliation complete',
        expect.objectContaining({
          workspacesScanned: 2,
          workspacesChanged: 2,
          deltasEmitted: 3,
        })
      );
    });

    it('reports zero changes and deltas for repeated unchanged reconciliation', async () => {
      mockFindAllNonArchived.mockResolvedValue([
        createMockWorkspace({ id: 'ws-1', worktreePath: null }),
      ]);
      mockGetByWorkspaceId.mockReturnValue(createSnapshotEntry());
      mockUpsert
        .mockReturnValueOnce({ accepted: true, changed: true, emitted: true })
        .mockReturnValue({ accepted: true, changed: false, emitted: false });

      const initial = await service.reconcile();
      const unchanged = await service.reconcile();

      expect(initial).toMatchObject({
        workspacesScanned: 1,
        workspacesChanged: 1,
        deltasEmitted: 1,
      });
      expect(unchanged).toMatchObject({
        workspacesScanned: 1,
        workspacesChanged: 0,
        deltasEmitted: 0,
      });
      expect(mockLoggerInfo).toHaveBeenLastCalledWith(
        'Reconciliation complete',
        expect.objectContaining({
          workspacesScanned: 1,
          workspacesChanged: 0,
          deltasEmitted: 0,
        })
      );
    });
  });

  describe('lifecycle (start/stop)', () => {
    it('runs initial reconciliation immediately on start()', async () => {
      mockFindAllNonArchived.mockResolvedValue([]);

      service.start();

      // Wait for the initial reconcile to complete
      // Use a small delay to let the promise settle
      await vi.waitFor(() => {
        expect(mockFindAllNonArchived).toHaveBeenCalledTimes(1);
      });
    });

    it('skips tick if previous reconciliation still in progress', async () => {
      vi.useFakeTimers();

      // Make reconcile take a long time
      let resolveReconcile: () => void;
      const longPromise = new Promise<void>((resolve) => {
        resolveReconcile = resolve;
      });
      mockFindAllNonArchived.mockReturnValue(longPromise.then(() => []));

      service.start();

      // Advance past reconciliation interval -- tick should be skipped
      // because initial reconciliation is still in progress
      vi.advanceTimersByTime(120_000);

      // findAllNonArchived should only have been called once (initial)
      expect(mockFindAllNonArchived).toHaveBeenCalledTimes(1);

      // Clean up
      resolveReconcile!();
      await vi.waitFor(() => {
        // Wait for promise to settle
        expect(mockFindAllNonArchived).toHaveBeenCalledTimes(1);
      });

      vi.useRealTimers();
    });

    it('stop() clears interval and awaits in-progress reconciliation', async () => {
      let resolveReconcile: () => void;
      const longPromise = new Promise<void>((resolve) => {
        resolveReconcile = resolve;
      });
      mockFindAllNonArchived.mockReturnValue(longPromise.then(() => []));

      service.start();

      // Stop while reconciliation is in progress
      const stopPromise = service.stop();

      // Resolve the reconcile
      resolveReconcile!();

      // stop() should await the in-progress reconciliation
      await stopPromise;

      // Confirm it completed
      expect(mockFindAllNonArchived).toHaveBeenCalledTimes(1);
    });
  });
});
