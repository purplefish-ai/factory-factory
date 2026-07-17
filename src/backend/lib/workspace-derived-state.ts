import type { RatchetDispatchOutcome } from '@prisma-gen/client';
import type {
  CIStatus,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  WorkspaceStatus,
} from '@/shared/core';
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
  ratchetDispatchOutcome: RatchetDispatchOutcome | null;
  ratchetDispatchRetryCount: number;
  runScriptStatus: RunScriptStatus | null;
  flowState: WorkspaceDerivedFlowState;
}

export interface WorkspaceDerivedStateFns {
  computeKanbanColumn: (input: {
    lifecycle: WorkspaceStatus;
    sessionIsWorking: boolean;
    flowIsWorking: boolean;
    prState: PRState;
    ratchetState: RatchetState;
    pendingRequestType: WorkspacePendingRequestType | null;
    hasSessionRuntimeError: boolean;
    ratchetDispatchOutcome: RatchetDispatchOutcome | null;
    ratchetDispatchRetryCount: number;
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
      sessionIsWorking: input.sessionIsWorking,
      flowIsWorking: input.flowState.isWorking,
      prState: input.prState,
      ratchetState: input.ratchetState,
      pendingRequestType: input.pendingRequestType,
      hasSessionRuntimeError: input.hasSessionRuntimeError ?? false,
      ratchetDispatchOutcome: input.ratchetDispatchOutcome,
      ratchetDispatchRetryCount: input.ratchetDispatchRetryCount,
    }),
    flowPhase: input.flowState.phase,
    ciObservation: input.flowState.ciObservation,
    ratchetButtonAnimated: input.flowState.shouldAnimateRatchetButton,
    statusReason: deriveWorkspaceStatusReason({
      lifecycle: input.lifecycle,
      hasHadSessions: input.hasHadSessions,
      isWorking,
      pendingRequestType: input.pendingRequestType,
      hasSessionRuntimeError: input.hasSessionRuntimeError,
      flowPhase: input.flowState.phase,
      ciObservation: input.flowState.ciObservation,
      prState: input.prState,
      prCiStatus: input.prCiStatus,
      ratchetState: input.ratchetState,
      runScriptStatus: input.runScriptStatus,
    }),
  };
}
