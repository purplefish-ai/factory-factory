import type {
  AutoIterationStatus,
  CIStatus,
  KanbanColumn,
  PRState,
  RatchetState,
  WorkspaceMode,
  WorkspaceStatus,
} from '@/shared/core';
import { kanbanColumnForStatusReason } from '@/shared/kanban-column-projection';
import type { WorkspaceCiObservation, WorkspaceFlowPhase } from '@/shared/workspace-flow-state';
import type { WorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import {
  deriveWorkspaceStatusReason,
  type WorkspacePendingRequestType,
  type WorkspaceStatusReason,
} from '@/shared/workspace-status-reason';

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
  pendingRequestType: WorkspacePendingRequestType | null;
  hasSessionRuntimeError?: boolean;
  isSessionStarting: boolean;
  ratchetEnabled: boolean;
  hasMergeConflict: boolean;
  dispatchStalled: boolean;
  mode: WorkspaceMode;
  autoIterationStatus: AutoIterationStatus | null;
  flowState: WorkspaceDerivedFlowState;
}

export interface WorkspaceDerivedStateFns {
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
  statusReason: WorkspaceStatusReason;
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
  const isWorking = input.sessionIsWorking;

  // The reason is computed first and the column read off it, so there is no
  // path that reaches a column without going through a reason.
  const statusReason = deriveWorkspaceStatusReason({
    lifecycle: input.lifecycle,
    hasHadSessions: input.hasHadSessions,
    isWorking,
    isSessionStarting: input.isSessionStarting,
    pendingRequestType: input.pendingRequestType,
    hasSessionRuntimeError: input.hasSessionRuntimeError,
    flowPhase: input.flowState.phase,
    ciObservation: input.flowState.ciObservation,
    prState: input.prState,
    prCiStatus: input.prCiStatus,
    ratchetState: input.ratchetState,
    ratchetEnabled: input.ratchetEnabled,
    hasMergeConflict: input.hasMergeConflict,
    dispatchStalled: input.dispatchStalled,
    mode: input.mode,
    autoIterationStatus: input.autoIterationStatus,
  });

  return {
    isWorking,
    sidebarStatus: fns.deriveSidebarStatus({
      isWorking,
      prUrl: input.prUrl,
      prState: input.prState,
      prCiStatus: input.prCiStatus,
      ratchetState: input.ratchetState,
    }),
    kanbanColumn: kanbanColumnForStatusReason(statusReason.code),
    flowPhase: input.flowState.phase,
    ciObservation: input.flowState.ciObservation,
    ratchetButtonAnimated: input.flowState.shouldAnimateRatchetButton,
    statusReason,
  };
}
