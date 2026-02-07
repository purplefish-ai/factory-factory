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

/**
 * Unified workspace agent status combining agent activity and CI state
 */
export type WorkspaceAgentStatus =
  | 'IDLE' // Agent is idle, no PR
  | 'STARTING' // Agent process is starting
  | 'WORKING' // Agent is actively working
  | 'CI_RUNNING' // PR exists, CI is running
  | 'CI_PASSING' // PR exists, CI passed
  | 'CI_FAILING' // PR exists, CI failed
  | 'MERGED'; // PR has been merged

export interface WorkspaceSidebarStatus {
  activityState: WorkspaceSidebarActivityState;
  ciState: WorkspaceSidebarCiState;
  /** Unified status field combining agent and CI state */
  agentStatus: WorkspaceAgentStatus;
}

export interface WorkspaceSidebarStatusInput {
  isWorking: boolean;
  isStarting?: boolean; // True when agent process has been initiated but not fully running
  prUrl: string | null;
  prState: PRState | null;
  prCiStatus: CIStatus | null;
  ratchetState: RatchetState | null;
}

function deriveCiAgentStatus(
  prCiStatus: CIStatus | null,
  ratchetState: RatchetState | null,
  isWorking: boolean
): WorkspaceAgentStatus {
  if (ratchetState === 'CI_FAILED' || prCiStatus === 'FAILURE') {
    return 'CI_FAILING';
  }
  if (ratchetState === 'CI_RUNNING' || prCiStatus === 'PENDING') {
    return 'CI_RUNNING';
  }
  if (prCiStatus === 'SUCCESS') {
    return 'CI_PASSING';
  }
  return isWorking ? 'WORKING' : 'IDLE';
}

function deriveAgentStatus(input: WorkspaceSidebarStatusInput): WorkspaceAgentStatus {
  // Check for merged state first (highest priority)
  if (input.prState === 'MERGED' || input.ratchetState === 'MERGED') {
    return 'MERGED';
  }

  // Check if agent is starting
  if (input.isStarting) {
    return 'STARTING';
  }

  // Check if agent is actively working (not CI-related)
  if (input.isWorking && !input.prUrl) {
    return 'WORKING';
  }

  // Handle CI states when PR exists
  if (input.prUrl) {
    return deriveCiAgentStatus(input.prCiStatus, input.ratchetState, input.isWorking);
  }

  // Default: idle
  return 'IDLE';
}

export function deriveWorkspaceSidebarStatus(
  input: WorkspaceSidebarStatusInput
): WorkspaceSidebarStatus {
  const activityState: WorkspaceSidebarActivityState = input.isWorking ? 'WORKING' : 'IDLE';

  if (!input.prUrl) {
    return {
      activityState,
      ciState: 'NONE',
      agentStatus: deriveAgentStatus(input),
    };
  }

  if (input.prState === 'MERGED' || input.ratchetState === 'MERGED') {
    return {
      activityState,
      ciState: 'MERGED',
      agentStatus: 'MERGED',
    };
  }

  if (input.ratchetState === 'CI_FAILED') {
    return {
      activityState,
      ciState: 'FAILING',
      agentStatus: deriveAgentStatus(input),
    };
  }

  if (input.ratchetState === 'CI_RUNNING') {
    return {
      activityState,
      ciState: 'RUNNING',
      agentStatus: deriveAgentStatus(input),
    };
  }

  return {
    activityState,
    ciState: deriveCiVisualStateFromPrCiStatus(input.prCiStatus),
    agentStatus: deriveAgentStatus(input),
  };
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

/**
 * Get human-readable label for unified agent status
 */
export function getWorkspaceAgentStatusLabel(status: WorkspaceAgentStatus): string {
  switch (status) {
    case 'IDLE':
      return 'Idle';
    case 'STARTING':
      return 'Starting';
    case 'WORKING':
      return 'Working';
    case 'CI_RUNNING':
      return 'CI Running';
    case 'CI_PASSING':
      return 'CI Passed';
    case 'CI_FAILING':
      return 'CI Failed';
    case 'MERGED':
      return 'Merged';
  }
}

/**
 * Get tooltip text for unified agent status
 */
export function getWorkspaceAgentStatusTooltip(status: WorkspaceAgentStatus): string {
  switch (status) {
    case 'IDLE':
      return 'Agent is idle';
    case 'STARTING':
      return 'Agent is starting up';
    case 'WORKING':
      return 'Agent is working';
    case 'CI_RUNNING':
      return 'CI checks are running';
    case 'CI_PASSING':
      return 'CI checks passed';
    case 'CI_FAILING':
      return 'CI checks failed';
    case 'MERGED':
      return 'PR has been merged';
  }
}
