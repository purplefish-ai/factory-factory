import { describe, expect, it, vi } from 'vitest';
import { KanbanColumn, PRState, RatchetState, WorkspaceStatus } from '@/shared/core';
import {
  assembleWorkspaceDerivedState,
  DEFAULT_WORKSPACE_DERIVED_FLOW_STATE,
  type WorkspaceDerivedStateInput,
} from './workspace-derived-state';

function makeInput(
  overrides: Partial<WorkspaceDerivedStateInput> = {}
): WorkspaceDerivedStateInput {
  return {
    lifecycle: WorkspaceStatus.READY,
    prUrl: null,
    prState: PRState.NONE,
    prCiStatus: 'UNKNOWN',
    ratchetState: RatchetState.IDLE,
    hasHadSessions: true,
    sessionIsWorking: false,
    pendingRequestType: null,
    isSessionStarting: false,
    ratchetEnabled: false,
    hasMergeConflict: false,
    dispatchStalled: false,
    mode: 'STANDARD',
    autoIterationStatus: null,
    flowState: DEFAULT_WORKSPACE_DERIVED_FLOW_STATE,
    ...overrides,
  };
}

describe('assembleWorkspaceDerivedState', () => {
  it('uses live session activity, not PR flow activity, for workspace working state', () => {
    const deriveSidebarStatus = vi.fn(() => ({
      activityState: 'IDLE' as const,
      ciState: 'NONE' as const,
    }));

    const result = assembleWorkspaceDerivedState(
      makeInput({
        flowState: {
          ...DEFAULT_WORKSPACE_DERIVED_FLOW_STATE,
          isWorking: true,
        },
      }),
      { deriveSidebarStatus }
    );

    expect(result.isWorking).toBe(false);
    expect(deriveSidebarStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        isWorking: false,
      })
    );
    expect(result.flowPhase).toBe('NO_PR');
  });

  it('projects the kanban column from the status reason it just computed', () => {
    const idle = assembleWorkspaceDerivedState(makeInput(), {
      deriveSidebarStatus: () => ({ activityState: 'IDLE', ciState: 'NONE' }),
    });
    expect(idle.statusReason.code).toBe('READY_FOR_NEXT_PROMPT');
    expect(idle.kanbanColumn).toBe(KanbanColumn.WAITING);

    const working = assembleWorkspaceDerivedState(makeInput({ sessionIsWorking: true }), {
      deriveSidebarStatus: () => ({ activityState: 'WORKING', ciState: 'NONE' }),
    });
    expect(working.statusReason.code).toBe('AGENT_WORKING');
    expect(working.kanbanColumn).toBe(KanbanColumn.WORKING);
  });

  it('maps flow fields and computed values into canonical derived shape', () => {
    const result = assembleWorkspaceDerivedState(
      makeInput({
        prUrl: 'https://github.com/org/repo/pull/1',
        prState: PRState.OPEN,
        prCiStatus: 'PENDING',
        ratchetState: RatchetState.REVIEW_PENDING,
        flowState: {
          phase: 'CI_WAIT',
          ciObservation: 'CHECKS_PENDING',
          hasActivePr: true,
          isWorking: true,
          shouldAnimateRatchetButton: true,
        },
      }),
      {
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
    const deriveSidebarStatus = vi.fn(() => ({
      activityState: 'WORKING' as const,
      ciState: 'NONE' as const,
    }));

    const result = assembleWorkspaceDerivedState(makeInput({ sessionIsWorking: true }), {
      deriveSidebarStatus,
    });

    expect(result.isWorking).toBe(true);
    expect(deriveSidebarStatus).toHaveBeenCalledWith(expect.objectContaining({ isWorking: true }));
  });
});
