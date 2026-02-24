import { describe, expect, it, vi } from 'vitest';
import { KanbanColumn, PRState, RatchetState, WorkspaceStatus } from '@/shared/core';
import {
  assembleWorkspaceDerivedState,
  DEFAULT_WORKSPACE_DERIVED_FLOW_STATE,
} from './workspace-derived-state';

describe('assembleWorkspaceDerivedState', () => {
  it('uses effective working state from session OR flow', () => {
    const computeKanbanColumn = vi.fn(() => KanbanColumn.WORKING);
    const deriveSidebarStatus = vi.fn(() => ({
      activityState: 'WORKING' as const,
      ciState: 'NONE' as const,
    }));

    const result = assembleWorkspaceDerivedState(
      {
        lifecycle: WorkspaceStatus.READY,
        prUrl: null,
        prState: PRState.NONE,
        prCiStatus: 'UNKNOWN',
        ratchetState: RatchetState.IDLE,
        hasHadSessions: true,
        sessionIsWorking: false,
        flowState: {
          ...DEFAULT_WORKSPACE_DERIVED_FLOW_STATE,
          isWorking: true,
        },
      },
      {
        computeKanbanColumn,
        deriveSidebarStatus,
      }
    );

    expect(result.isWorking).toBe(true);
    expect(computeKanbanColumn).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: WorkspaceStatus.READY,
        isWorking: true,
      })
    );
    expect(deriveSidebarStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        isWorking: true,
      })
    );
  });

  it('maps flow fields and computed values into canonical derived shape', () => {
    const result = assembleWorkspaceDerivedState(
      {
        lifecycle: WorkspaceStatus.READY,
        prUrl: 'https://github.com/org/repo/pull/1',
        prState: PRState.OPEN,
        prCiStatus: 'PENDING',
        ratchetState: RatchetState.REVIEW_PENDING,
        hasHadSessions: true,
        sessionIsWorking: false,
        flowState: {
          phase: 'CI_WAIT',
          ciObservation: 'CHECKS_PENDING',
          hasActivePr: true,
          isWorking: true,
          shouldAnimateRatchetButton: true,
        },
      },
      {
        computeKanbanColumn: () => KanbanColumn.WORKING,
        deriveSidebarStatus: () => ({ activityState: 'WORKING', ciState: 'RUNNING' }),
      }
    );

    expect(result).toEqual({
      isWorking: true,
      kanbanColumn: KanbanColumn.WORKING,
      sidebarStatus: { activityState: 'WORKING', ciState: 'RUNNING' },
      ratchetButtonAnimated: true,
      flowPhase: 'CI_WAIT',
      ciObservation: 'CHECKS_PENDING',
    });
  });
});
