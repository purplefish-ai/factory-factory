import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStatus } from '@/shared/core';

const mockFindById = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockDeriveRuntimeState = vi.hoisted(() => vi.fn());
const mockDeriveFlowStateFromWorkspace = vi.hoisted(() => vi.fn());

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
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

import { computeKanbanColumn, kanbanStateService } from './kanban-state';

describe('computeKanbanColumn', () => {
  it('maps archived to hidden', () => {
    expect(
      computeKanbanColumn({
        lifecycle: 'ARCHIVED',
        isWorking: false,
        prState: 'OPEN',
        ratchetState: 'IDLE',
        hasHadSessions: true,
      })
    ).toBeNull();
  });

  it('maps initializing or active work to WORKING', () => {
    expect(
      computeKanbanColumn({
        lifecycle: 'NEW',
        isWorking: false,
        prState: 'NONE',
        ratchetState: 'IDLE',
        hasHadSessions: false,
      })
    ).toBe('WORKING');
    expect(
      computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: true,
        prState: 'OPEN',
        ratchetState: 'IDLE',
        hasHadSessions: true,
      })
    ).toBe('WORKING');
  });

  it('maps merged PRs to DONE and hidden empty READY workspaces to null', () => {
    expect(
      computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'MERGED',
        ratchetState: 'IDLE',
        hasHadSessions: true,
      })
    ).toBe('DONE');
    expect(
      computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'NONE',
        ratchetState: 'IDLE',
        hasHadSessions: false,
      })
    ).toBeNull();
  });

  it('maps ratchet MERGED to DONE even if prState has not caught up yet', () => {
    expect(
      computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'OPEN',
        ratchetState: 'MERGED',
        hasHadSessions: true,
      })
    ).toBe('DONE');
  });

  it('maps idle session-backed workspaces to WAITING', () => {
    expect(
      computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'APPROVED',
        ratchetState: 'IDLE',
        hasHadSessions: true,
      })
    ).toBe('WAITING');
  });
});

describe('kanbanStateService', () => {
  const sessionBridge = {
    isAnySessionWorking: vi.fn(),
    getAllPendingRequests: vi.fn(() => new Map()),
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
    });
    mockDeriveRuntimeState.mockReturnValue({ isWorking: false });

    await expect(kanbanStateService.getWorkspaceKanbanState('w1')).resolves.toEqual({
      workspace: expect.objectContaining({ id: 'w1' }),
      kanbanColumn: 'WAITING',
      isWorking: false,
    });
  });

  it('computes batch kanban state using workingStatus map', () => {
    mockDeriveRuntimeState
      .mockReturnValueOnce({ isWorking: false })
      .mockReturnValueOnce({ isWorking: true });

    const result = kanbanStateService.getWorkspacesKanbanStates(
      [
        {
          id: 'w1',
          status: WorkspaceStatus.READY,
          prState: 'OPEN',
          ratchetState: 'IDLE',
          hasHadSessions: true,
        },
        {
          id: 'w2',
          status: WorkspaceStatus.READY,
          prState: 'NONE',
          ratchetState: 'IDLE',
          hasHadSessions: true,
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
