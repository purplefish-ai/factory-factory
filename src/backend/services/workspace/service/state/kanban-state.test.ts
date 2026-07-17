import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_THRESHOLDS } from '@/backend/services/constants';
import type { WorkspaceSessionBridge } from '@/backend/services/workspace/service/bridges';
import { PRState, RatchetState, WorkspaceStatus } from '@/shared/core';

const mockFindById = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockDeriveRuntimeState = vi.hoisted(() => vi.fn());
const mockDeriveFlowStateFromWorkspace = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    updateCachedKanbanColumnIfOwnershipMatches: (
      workspaceId: string,
      _expected: unknown,
      data: unknown
    ) => mockUpdate(workspaceId, data),
  },
}));

vi.mock('./workspace-runtime-state', () => ({
  deriveWorkspaceRuntimeState: (...args: unknown[]) => mockDeriveRuntimeState(...args),
}));

vi.mock('./flow-state', () => ({
  deriveWorkspaceFlowStateFromWorkspace: (...args: unknown[]) =>
    mockDeriveFlowStateFromWorkspace(...args),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { computeKanbanColumn, type KanbanStateInput, kanbanStateService } from './kanban-state';

function makeInput(overrides: Partial<KanbanStateInput> = {}): KanbanStateInput {
  return {
    lifecycle: WorkspaceStatus.READY,
    sessionIsWorking: false,
    flowIsWorking: false,
    prState: PRState.NONE,
    ratchetState: RatchetState.IDLE,
    pendingRequestType: null,
    hasSessionRuntimeError: false,
    ratchetDispatchOutcome: null,
    ratchetDispatchRetryCount: 0,
    ...overrides,
  };
}

describe('computeKanbanColumn', () => {
  it('hides archiving and archived workspaces', () => {
    expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.ARCHIVING }))).toBeNull();
    expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.ARCHIVED }))).toBeNull();
  });

  it('maps merged and closed pull requests to DONE before human-attention rules', () => {
    expect(
      computeKanbanColumn(
        makeInput({
          lifecycle: WorkspaceStatus.FAILED,
          prState: PRState.MERGED,
          pendingRequestType: 'permission_request',
        })
      )
    ).toBe('DONE');
    expect(computeKanbanColumn(makeInput({ prState: PRState.CLOSED }))).toBe('DONE');
    expect(computeKanbanColumn(makeInput({ ratchetState: RatchetState.MERGED }))).toBe('DONE');
  });

  it('maps explicit human-attention states to WAITING before automation-owned states', () => {
    expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.FAILED }))).toBe('WAITING');
    expect(
      computeKanbanColumn(
        makeInput({ flowIsWorking: true, pendingRequestType: 'permission_request' })
      )
    ).toBe('WAITING');
    expect(
      computeKanbanColumn(
        makeInput({ sessionIsWorking: true, pendingRequestType: 'plan_approval' })
      )
    ).toBe('WAITING');
    expect(computeKanbanColumn(makeInput({ pendingRequestType: 'user_question' }))).toBe('WAITING');
    expect(
      computeKanbanColumn(makeInput({ flowIsWorking: true, hasSessionRuntimeError: true }))
    ).toBe('WAITING');
    expect(
      computeKanbanColumn(
        makeInput({
          ratchetState: RatchetState.CI_FAILED,
          flowIsWorking: true,
          ratchetDispatchOutcome: 'DIED',
          ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
        })
      )
    ).toBe('WAITING');
  });

  it('maps initializing, session-active, and flow-active workspaces to WORKING', () => {
    expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.NEW }))).toBe('WORKING');
    expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.PROVISIONING }))).toBe(
      'WORKING'
    );
    expect(computeKanbanColumn(makeInput({ sessionIsWorking: true }))).toBe('WORKING');
    expect(computeKanbanColumn(makeInput({ flowIsWorking: true }))).toBe('WORKING');
    expect(
      computeKanbanColumn(
        makeInput({
          flowIsWorking: true,
          ratchetDispatchOutcome: 'COMPLETED',
        })
      )
    ).toBe('WORKING');
  });

  it('maps remaining idle ready workspaces to WAITING', () => {
    expect(computeKanbanColumn(makeInput())).toBe('WAITING');
  });
});

describe('kanbanStateService', () => {
  const sessionBridge = {
    isAnySessionWorking: vi.fn(),
    getAllPendingRequests: vi.fn(() => new Map()),
    getRuntimeSnapshot: vi.fn<WorkspaceSessionBridge['getRuntimeSnapshot']>(() => ({
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(true);
    kanbanStateService.configure({ session: sessionBridge });
  });

  it('returns null when workspace is missing', async () => {
    mockFindById.mockResolvedValue(null);

    await expect(kanbanStateService.getWorkspaceKanbanState('missing')).resolves.toBeNull();
  });

  it('gets kanban state for one workspace', async () => {
    mockFindById.mockResolvedValue({
      id: 'w1',
      status: WorkspaceStatus.READY,
      prState: 'OPEN',
      ratchetState: 'IDLE',
      hasHadSessions: true,
      agentSessions: [],
    });
    mockDeriveRuntimeState.mockReturnValue({
      sessionIds: [],
      isSessionWorking: false,
      isWorking: false,
      flowState: { isWorking: false },
    });

    await expect(kanbanStateService.getWorkspaceKanbanState('w1')).resolves.toEqual({
      workspace: expect.objectContaining({ id: 'w1' }),
      kanbanColumn: 'WAITING',
      isWorking: false,
    });
  });

  it('keeps a workspace with a pending permission request in WAITING', async () => {
    mockFindById.mockResolvedValue({
      id: 'w-pending',
      status: WorkspaceStatus.READY,
      prState: PRState.NONE,
      ratchetState: RatchetState.IDLE,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
      agentSessions: [
        {
          id: 's-pending',
          name: 'Agent',
          workflow: 'followup',
          model: 'gpt-5',
          provider: 'CODEX',
          status: 'RUNNING',
        },
      ],
    });
    mockDeriveRuntimeState.mockReturnValue({
      sessionIds: ['s-pending'],
      isSessionWorking: true,
      isWorking: true,
      flowState: { isWorking: false },
    });
    sessionBridge.getAllPendingRequests.mockReturnValue(
      new Map([['s-pending', { toolName: 'Bash' }]])
    );

    await expect(kanbanStateService.getWorkspaceKanbanState('w-pending')).resolves.toMatchObject({
      kanbanColumn: 'WAITING',
      isWorking: true,
    });
  });

  it('computes batch kanban state using workingStatus map', () => {
    mockDeriveRuntimeState
      .mockReturnValueOnce({
        sessionIds: [],
        isSessionWorking: false,
        isWorking: false,
        flowState: { isWorking: false },
      })
      .mockReturnValueOnce({
        sessionIds: [],
        isSessionWorking: true,
        isWorking: true,
        flowState: { isWorking: false },
      });

    const result = kanbanStateService.getWorkspacesKanbanStates(
      [
        {
          id: 'w1',
          status: WorkspaceStatus.READY,
          prState: 'OPEN',
          ratchetState: 'IDLE',
          hasHadSessions: true,
          agentSessions: [],
        },
        {
          id: 'w2',
          status: WorkspaceStatus.READY,
          prState: 'NONE',
          ratchetState: 'IDLE',
          hasHadSessions: true,
          agentSessions: [],
        },
      ] as never,
      new Map([
        ['w1', false],
        ['w2', true],
      ])
    );

    expect(result).toMatchObject([
      { workspace: { id: 'w1' }, kanbanColumn: 'WAITING', isWorking: false },
      { workspace: { id: 'w2' }, kanbanColumn: 'WORKING', isWorking: true },
    ]);
  });

  it('keeps a batch workspace with a session runtime error in WAITING', () => {
    mockDeriveRuntimeState.mockReturnValue({
      sessionIds: ['s-error'],
      isSessionWorking: true,
      isWorking: true,
      flowState: { isWorking: false },
    });
    sessionBridge.getRuntimeSnapshot.mockReturnValue({
      phase: 'error',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-01-01T00:00:00.000Z',
      errorMessage: 'ACP runtime failed',
    });

    const result = kanbanStateService.getWorkspacesKanbanStates(
      [
        {
          id: 'w-error',
          status: WorkspaceStatus.READY,
          prState: PRState.NONE,
          ratchetState: RatchetState.IDLE,
          ratchetDispatchOutcome: null,
          ratchetDispatchRetryCount: 0,
          agentSessions: [
            {
              id: 's-error',
              name: 'Agent',
              workflow: 'followup',
              model: 'gpt-5',
              provider: 'CODEX',
              status: 'RUNNING',
            },
          ],
        },
      ] as never,
      new Map([['w-error', true]])
    );

    expect(result).toMatchObject([
      { workspace: { id: 'w-error' }, kanbanColumn: 'WAITING', isWorking: true },
    ]);
  });

  it('updates cached kanban column and stateComputedAt only when column changes', async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: 'w1',
        status: WorkspaceStatus.READY,
        prState: 'OPEN',
        ratchetState: 'IDLE',
        hasHadSessions: true,
        cachedKanbanColumn: 'WORKING',
      })
      .mockResolvedValueOnce({
        id: 'w2',
        status: WorkspaceStatus.READY,
        prState: 'OPEN',
        ratchetState: 'IDLE',
        hasHadSessions: true,
        cachedKanbanColumn: 'WAITING',
      })
      .mockResolvedValueOnce({
        id: 'w3',
        status: WorkspaceStatus.ARCHIVED,
        prState: 'OPEN',
        ratchetState: 'IDLE',
        hasHadSessions: true,
        cachedKanbanColumn: 'WAITING',
      });

    mockDeriveFlowStateFromWorkspace
      .mockReturnValueOnce({ isWorking: false })
      .mockReturnValueOnce({ isWorking: false });

    await kanbanStateService.updateCachedKanbanColumn('w1');
    expect(mockUpdate).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        cachedKanbanColumn: 'WAITING',
        stateComputedAt: expect.any(Date),
      })
    );

    await kanbanStateService.updateCachedKanbanColumn('w2');
    expect(mockUpdate).toHaveBeenCalledWith('w2', { cachedKanbanColumn: 'WAITING' });

    await kanbanStateService.updateCachedKanbanColumn('w3');
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('serializes refreshes so a slower old read cannot overwrite a newer column', async () => {
    let resolveOldRead!: (value: unknown) => void;
    const oldRead = new Promise((resolve) => {
      resolveOldRead = resolve;
    });
    mockFindById.mockReturnValueOnce(oldRead).mockResolvedValueOnce({
      id: 'w-race',
      status: WorkspaceStatus.READY,
      prState: PRState.OPEN,
      ratchetState: RatchetState.IDLE,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
      cachedKanbanColumn: 'WORKING',
    });
    mockDeriveFlowStateFromWorkspace.mockImplementation((workspace) => ({
      isWorking: workspace.ratchetState === RatchetState.CI_RUNNING,
    }));

    const oldRefresh = kanbanStateService.updateCachedKanbanColumn('w-race');
    await vi.waitFor(() => expect(mockFindById).toHaveBeenCalledTimes(1));
    const newRefresh = kanbanStateService.updateCachedKanbanColumn('w-race');
    resolveOldRead({
      id: 'w-race',
      status: WorkspaceStatus.READY,
      prState: PRState.OPEN,
      ratchetState: RatchetState.CI_RUNNING,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
      cachedKanbanColumn: 'WAITING',
    });

    await Promise.all([oldRefresh, newRefresh]);

    expect(mockUpdate).toHaveBeenLastCalledWith(
      'w-race',
      expect.objectContaining({ cachedKanbanColumn: 'WAITING' })
    );
  });

  it('retries a failed cached-column refresh without another invalidation', async () => {
    mockFindById.mockRejectedValueOnce(new Error('read failed')).mockResolvedValue({
      id: 'w-retry',
      status: WorkspaceStatus.READY,
      prState: PRState.OPEN,
      ratchetState: RatchetState.IDLE,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
      cachedKanbanColumn: 'WORKING',
    });
    mockDeriveFlowStateFromWorkspace.mockReturnValue({ isWorking: false });

    await kanbanStateService.updateCachedKanbanColumn('w-retry');

    expect(mockFindById).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenCalledWith(
      'w-retry',
      expect.objectContaining({ cachedKanbanColumn: 'WAITING' })
    );
  });

  it('reruns after a lifecycle race and preserves the archived cached column', async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: 'w-archive-race',
        status: WorkspaceStatus.READY,
        prState: PRState.OPEN,
        ratchetState: RatchetState.CI_RUNNING,
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
        cachedKanbanColumn: 'WORKING',
      })
      .mockResolvedValueOnce({
        id: 'w-archive-race',
        status: WorkspaceStatus.ARCHIVED,
        cachedKanbanColumn: 'WORKING',
      });
    mockDeriveFlowStateFromWorkspace.mockReturnValue({ isWorking: false });
    mockUpdate.mockResolvedValueOnce(false);

    await kanbanStateService.updateCachedKanbanColumn('w-archive-race');

    expect(mockFindById).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('cancels a failed refresh retry when reconfigured', async () => {
    vi.useFakeTimers();
    mockFindById.mockRejectedValue(new Error('read failed'));

    const refresh = kanbanStateService.updateCachedKanbanColumn('w-cancel');
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFindById).toHaveBeenCalledTimes(1);
    kanbanStateService.configure({ session: sessionBridge });
    await refresh;
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFindById).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('caches WORKING for pending CI without a live session', async () => {
    mockFindById.mockResolvedValue({
      id: 'w-ci',
      status: WorkspaceStatus.READY,
      prUrl: 'https://github.com/org/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: 'PENDING',
      prUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_RUNNING,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
      cachedKanbanColumn: 'WAITING',
    });
    mockDeriveFlowStateFromWorkspace.mockReturnValue({ isWorking: true });

    await kanbanStateService.updateCachedKanbanColumn('w-ci');

    expect(mockUpdate).toHaveBeenCalledWith(
      'w-ci',
      expect.objectContaining({
        cachedKanbanColumn: 'WORKING',
        stateComputedAt: expect.any(Date),
      })
    );
  });

  it('caches WAITING when a ratchet dispatch has died at the retry limit', async () => {
    mockFindById.mockResolvedValue({
      id: 'w-exhausted',
      status: WorkspaceStatus.READY,
      prUrl: 'https://github.com/org/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: 'FAILURE',
      prUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetDispatchOutcome: 'DIED',
      ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
      cachedKanbanColumn: 'WORKING',
    });
    mockDeriveFlowStateFromWorkspace.mockReturnValue({ isWorking: true });

    await kanbanStateService.updateCachedKanbanColumn('w-exhausted');

    expect(mockUpdate).toHaveBeenCalledWith(
      'w-exhausted',
      expect.objectContaining({
        cachedKanbanColumn: 'WAITING',
        stateComputedAt: expect.any(Date),
      })
    );
  });

  it('updates cached columns in batch', async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: 'w1',
        status: WorkspaceStatus.READY,
        prState: 'NONE',
        ratchetState: 'IDLE',
        hasHadSessions: true,
        cachedKanbanColumn: 'WORKING',
      })
      .mockResolvedValueOnce({
        id: 'w2',
        status: WorkspaceStatus.READY,
        prState: 'NONE',
        ratchetState: 'IDLE',
        hasHadSessions: true,
        cachedKanbanColumn: 'WORKING',
      });
    mockDeriveFlowStateFromWorkspace.mockReturnValue({ isWorking: false });

    await kanbanStateService.updateCachedKanbanColumns(['w1', 'w2']);

    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });
});
