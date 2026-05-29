import { describe, expect, it, vi } from 'vitest';
import { KanbanColumn, PRState, RatchetState, WorkspaceStatus } from '@/shared/core';
import {
  assembleWorkspaceDerivedState,
  DEFAULT_WORKSPACE_DERIVED_FLOW_STATE,
} from './workspace-derived-state';

describe('assembleWorkspaceDerivedState', () => {
  it('uses live session activity, not PR flow activity, for workspace working state', () => {
    const computeKanbanColumn = vi.fn(() => KanbanColumn.WAITING);
    const deriveSidebarStatus = vi.fn(() => ({
      activityState: 'IDLE' as const,
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
        pendingRequestType: null,
        runScriptStatus: 'IDLE',
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

    expect(result.isWorking).toBe(false);
    expect(computeKanbanColumn).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: WorkspaceStatus.READY,
        isWorking: false,
      })
    );
    expect(deriveSidebarStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        isWorking: false,
      })
    );
    expect(result.flowPhase).toBe('NO_PR');
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
        pendingRequestType: null,
        runScriptStatus: 'IDLE',
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
        deriveSidebarStatus: () => ({ activityState: 'IDLE', ciState: 'RUNNING' }),
      }
    );

    expect(result).toEqual({
      isWorking: false,
      kanbanColumn: KanbanColumn.WORKING,
      sidebarStatus: { activityState: 'IDLE', ciState: 'RUNNING' },
      ratchetButtonAnimated: true,
      flowPhase: 'CI_WAIT',
      ciObservation: 'CHECKS_PENDING',
      statusReason: {
        code: 'WAITING_FOR_CI',
        label: 'Waiting for CI',
        tone: 'waiting',
        needsUser: false,
      },
    });
  });

  it('marks the workspace working when a session is actively working', () => {
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
        sessionIsWorking: true,
        pendingRequestType: null,
        runScriptStatus: 'IDLE',
        flowState: DEFAULT_WORKSPACE_DERIVED_FLOW_STATE,
      },
      {
        computeKanbanColumn,
        deriveSidebarStatus,
      }
    );

    expect(result.isWorking).toBe(true);
    expect(computeKanbanColumn).toHaveBeenCalledWith(expect.objectContaining({ isWorking: true }));
    expect(deriveSidebarStatus).toHaveBeenCalledWith(expect.objectContaining({ isWorking: true }));
  });
});
