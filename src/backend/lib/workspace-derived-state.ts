import type { CIStatus, KanbanColumn, PRState, RatchetState, WorkspaceStatus } from '@/shared/core';
import type { WorkspaceCiObservation, WorkspaceFlowPhase } from '@/shared/workspace-flow-state';
import type { WorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

export interface WorkspaceDerivedFlowState {
  phase: WorkspaceFlowPhase;
  ciObservation: WorkspaceCiObservation;
  hasActivePr: boolean;
  isWorking: boolean;
  shouldAnimateRatchetButton: boolean;
}

export interface WorkspaceDerivedStateInput {
  lifecycle: WorkspaceStatus;
  prUrl: string | null;
  prState: PRState;
  prCiStatus: CIStatus;
  ratchetState: RatchetState;
  hasHadSessions: boolean;
  sessionIsWorking: boolean;
  flowState: WorkspaceDerivedFlowState;
}

export interface WorkspaceDerivedStateFns {
  computeKanbanColumn: (input: {
    lifecycle: WorkspaceStatus;
    isWorking: boolean;
    prState: PRState;
    ratchetState: RatchetState;
    hasHadSessions: boolean;
  }) => KanbanColumn | null;
  deriveSidebarStatus: (input: {
    isWorking: boolean;
    prUrl: string | null;
    prState: PRState | null;
    prCiStatus: CIStatus | null;
    ratchetState: RatchetState | null;
  }) => WorkspaceSidebarStatus;
}

export interface WorkspaceDerivedState {
  isWorking: boolean;
  sidebarStatus: WorkspaceSidebarStatus;
  kanbanColumn: KanbanColumn | null;
  flowPhase: WorkspaceFlowPhase;
  ciObservation: WorkspaceCiObservation;
  ratchetButtonAnimated: boolean;
}

export const DEFAULT_WORKSPACE_DERIVED_FLOW_STATE: WorkspaceDerivedFlowState = {
  phase: 'NO_PR',
  ciObservation: 'CHECKS_UNKNOWN',
  hasActivePr: false,
  isWorking: false,
  shouldAnimateRatchetButton: false,
};

export function assembleWorkspaceDerivedState(
  input: WorkspaceDerivedStateInput,
  fns: WorkspaceDerivedStateFns
): WorkspaceDerivedState {
  const isWorking = input.sessionIsWorking || input.flowState.isWorking;

  return {
    isWorking,
    sidebarStatus: fns.deriveSidebarStatus({
      isWorking,
      prUrl: input.prUrl,
      prState: input.prState,
      prCiStatus: input.prCiStatus,
      ratchetState: input.ratchetState,
    }),
    kanbanColumn: fns.computeKanbanColumn({
      lifecycle: input.lifecycle,
      isWorking,
      prState: input.prState,
      ratchetState: input.ratchetState,
      hasHadSessions: input.hasHadSessions,
    }),
    flowPhase: input.flowState.phase,
    ciObservation: input.flowState.ciObservation,
    ratchetButtonAnimated: input.flowState.shouldAnimateRatchetButton,
  };
}
