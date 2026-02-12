import type { WorkspaceFlowState, WorkspaceFlowStateSource } from './flow-state.js';
import { deriveWorkspaceFlowStateFromWorkspace } from './flow-state.js';

type WorkspaceSessionSource = { id: string };

export interface WorkspaceRuntimeStateSource extends WorkspaceFlowStateSource {
  id: string;
  claudeSessions?: WorkspaceSessionSource[] | null;
}

export interface WorkspaceRuntimeState {
  sessionIds: string[];
  isSessionWorking: boolean;
  flowState: WorkspaceFlowState;
  isWorking: boolean;
}

export function deriveWorkspaceRuntimeState(
  workspace: WorkspaceRuntimeStateSource,
  resolveSessionWorking: (sessionIds: string[], workspaceId: string) => boolean
): WorkspaceRuntimeState {
  const sessionIds = workspace.claudeSessions?.map((session) => session.id) ?? [];
  const isSessionWorking = resolveSessionWorking(sessionIds, workspace.id);
  const flowState = deriveWorkspaceFlowStateFromWorkspace(workspace);

  return {
    sessionIds,
    isSessionWorking,
    flowState,
    isWorking: isSessionWorking || flowState.isWorking,
  };
}
