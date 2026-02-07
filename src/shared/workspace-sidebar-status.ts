export type WorkspaceSidebarActivityState = 'WORKING' | 'IDLE';

export type WorkspaceSidebarCiState =
  | 'NONE'
  | 'RUNNING'
  | 'FAILING'
  | 'PASSING'
  | 'UNKNOWN'
  | 'MERGED';

export interface WorkspaceSidebarStatus {
  activityState: WorkspaceSidebarActivityState;
  ciState: WorkspaceSidebarCiState;
}

export interface WorkspaceSidebarStatusInput {
  isWorking: boolean;
  prUrl: string | null;
  prState: string | null;
  prCiStatus: string | null;
  ratchetState: string | null;
}

export function deriveWorkspaceSidebarStatus(
  input: WorkspaceSidebarStatusInput
): WorkspaceSidebarStatus {
  const activityState: WorkspaceSidebarActivityState = input.isWorking ? 'WORKING' : 'IDLE';

  if (!input.prUrl) {
    return { activityState, ciState: 'NONE' };
  }

  if (input.prState === 'MERGED') {
    return { activityState, ciState: 'MERGED' };
  }

  if (input.ratchetState === 'CI_FAILED' || input.prCiStatus === 'FAILURE') {
    return { activityState, ciState: 'FAILING' };
  }

  if (input.ratchetState === 'CI_RUNNING' || input.prCiStatus === 'PENDING') {
    return { activityState, ciState: 'RUNNING' };
  }

  if (input.prCiStatus === 'SUCCESS') {
    return { activityState, ciState: 'PASSING' };
  }

  return { activityState, ciState: 'UNKNOWN' };
}

export function getWorkspaceActivityTooltip(state: WorkspaceSidebarActivityState): string {
  return state === 'WORKING' ? 'Claude is working' : 'Claude is idle';
}

export function getWorkspaceCiLabel(state: WorkspaceSidebarCiState): string {
  switch (state) {
    case 'NONE':
      return 'No PR';
    case 'RUNNING':
      return 'CI Running';
    case 'FAILING':
      return 'CI Failing';
    case 'PASSING':
      return 'CI Passing';
    case 'UNKNOWN':
      return 'CI Unknown';
    case 'MERGED':
      return 'Merged';
  }
}
