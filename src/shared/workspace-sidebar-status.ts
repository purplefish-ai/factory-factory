import type { CIStatus, PRState, RatchetState } from '@prisma-gen/browser';
import { deriveCiVisualStateFromPrCiStatus } from './ci-status';

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
  prState: PRState | null;
  prCiStatus: CIStatus | null;
  ratchetState: RatchetState | null;
}

export function deriveWorkspaceSidebarStatus(
  input: WorkspaceSidebarStatusInput
): WorkspaceSidebarStatus {
  const activityState: WorkspaceSidebarActivityState = input.isWorking ? 'WORKING' : 'IDLE';

  if (!input.prUrl) {
    return { activityState, ciState: 'NONE' };
  }

  if (input.prState === 'MERGED' || input.ratchetState === 'MERGED') {
    return { activityState, ciState: 'MERGED' };
  }

  const ciStateFromSnapshot = deriveCiVisualStateFromPrCiStatus(input.prCiStatus);
  if (ciStateFromSnapshot === 'UNKNOWN') {
    if (input.ratchetState === 'CI_FAILED') {
      return { activityState, ciState: 'FAILING' };
    }

    if (input.ratchetState === 'CI_RUNNING') {
      return { activityState, ciState: 'RUNNING' };
    }
  }

  return { activityState, ciState: ciStateFromSnapshot };
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

export function getWorkspaceCiTooltip(
  ciState: WorkspaceSidebarCiState,
  prState: PRState | null
): string {
  if (ciState === 'RUNNING') {
    return 'CI checks are running';
  }
  if (ciState === 'FAILING') {
    return 'CI checks are failing';
  }
  if (ciState === 'PASSING') {
    return 'CI checks are passing';
  }
  if (ciState === 'MERGED') {
    return 'PR is merged';
  }
  if (ciState === 'UNKNOWN') {
    return prState === 'CLOSED' ? 'PR is closed' : 'CI status is unknown';
  }
  return 'No PR attached';
}

export function getWorkspacePrTooltipSuffix(
  ciState: WorkspaceSidebarCiState,
  prState: PRState | null
): string {
  if (prState === 'CLOSED') {
    return ' · Closed';
  }
  if (ciState === 'MERGED') {
    return ' · Merged';
  }
  if (ciState === 'FAILING') {
    return ' · CI failing';
  }
  if (ciState === 'RUNNING') {
    return ' · CI running';
  }
  if (ciState === 'PASSING') {
    return ' · CI passing';
  }
  return '';
}
