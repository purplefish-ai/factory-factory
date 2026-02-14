import type { WorkspaceStatus } from '@/shared/core';
import type { WorkspaceInitBanner, WorkspaceInitPhase } from '@/shared/workspace-init';

export interface WorkspaceInitPolicyInput {
  status: WorkspaceStatus;
  worktreePath?: string | null;
  initErrorMessage?: string | null;
}

export interface WorkspaceInitPolicy {
  phase: WorkspaceInitPhase;
  banner: WorkspaceInitBanner | null;
  dispatchPolicy: 'allowed' | 'blocked' | 'manual_resume';
}

export function getWorkspaceInitPolicy(input: WorkspaceInitPolicyInput): WorkspaceInitPolicy {
  const phase = deriveWorkspaceInitPhase(input);

  if (phase === 'CREATING_WORKTREE') {
    return {
      phase,
      banner: {
        kind: 'info',
        message: 'Creating worktree...',
        showRetry: false,
        showPlay: false,
      },
      dispatchPolicy: 'blocked',
    };
  }

  if (phase === 'RUNNING_INIT_SCRIPT') {
    return {
      phase,
      banner: {
        kind: 'info',
        message: 'Running init script...',
        showRetry: false,
        showPlay: false,
      },
      dispatchPolicy: 'blocked',
    };
  }

  if (phase === 'BLOCKED_FAILED') {
    return {
      phase,
      banner: {
        kind: 'error',
        message: input.initErrorMessage || 'Workspace setup failed while creating the worktree.',
        showRetry: true,
        showPlay: false,
      },
      dispatchPolicy: 'blocked',
    };
  }

  if (phase === 'READY_WITH_WARNING') {
    return {
      phase,
      banner: {
        kind: 'warning',
        message: input.initErrorMessage || 'Init script failed. Workspace may be incomplete.',
        showRetry: false,
        showPlay: true,
      },
      dispatchPolicy: 'manual_resume',
    };
  }

  if (phase === 'ARCHIVED') {
    return {
      phase,
      banner: null,
      dispatchPolicy: 'blocked',
    };
  }

  return {
    phase,
    banner: null,
    dispatchPolicy: 'allowed',
  };
}

function deriveWorkspaceInitPhase(input: WorkspaceInitPolicyInput): WorkspaceInitPhase {
  const hasWorktree = Boolean(input.worktreePath);
  const hasWarning = Boolean(input.initErrorMessage);

  if (input.status === 'ARCHIVED') {
    return 'ARCHIVED';
  }

  if (input.status === 'NEW') {
    return 'CREATING_WORKTREE';
  }

  if (input.status === 'PROVISIONING') {
    return hasWorktree ? 'RUNNING_INIT_SCRIPT' : 'CREATING_WORKTREE';
  }

  // Legacy compatibility: FAILED with a worktree means script failed after worktree creation.
  if (input.status === 'FAILED') {
    return hasWorktree ? 'READY_WITH_WARNING' : 'BLOCKED_FAILED';
  }

  if (input.status === 'READY' && hasWorktree && hasWarning) {
    return 'READY_WITH_WARNING';
  }

  return 'READY';
}
