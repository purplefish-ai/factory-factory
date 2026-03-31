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
        showDismiss: false,
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
        showDismiss: false,
      },
      dispatchPolicy: 'blocked',
    };
  }

  if (phase === 'BLOCKED_FAILED') {
    return {
      phase,
      banner: {
        kind: 'error',
        message: getBlockedFailedMessage(input),
        showRetry: true,
        showPlay: false,
        showDismiss: false,
      },
      dispatchPolicy: 'blocked',
    };
  }

  if (phase === 'READY_WITH_WARNING') {
    const isReadyWithWarning = input.status === 'READY';
    return {
      phase,
      banner: {
        kind: 'warning',
        message: input.initErrorMessage || 'Init script failed. Workspace may be incomplete.',
        showRetry: true,
        // Legacy FAILED+worktree path: user must manually resume the agent
        showPlay: !isReadyWithWarning,
        // New READY+warning path: banner is dismissable
        showDismiss: isReadyWithWarning,
      },
      // READY+warning: workspace and agent are fully operational
      dispatchPolicy: isReadyWithWarning ? 'allowed' : 'manual_resume',
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
  const hasWorktree = hasUsableWorktreePath(input.worktreePath);
  const hasWarning = Boolean(input.initErrorMessage);

  if (input.status === 'ARCHIVING' || input.status === 'ARCHIVED') {
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

  if (!hasWorktree) {
    return 'BLOCKED_FAILED';
  }

  if (input.status === 'READY' && hasWarning) {
    return 'READY_WITH_WARNING';
  }

  return 'READY';
}

function getBlockedFailedMessage(input: WorkspaceInitPolicyInput): string {
  if (!hasUsableWorktreePath(input.worktreePath) && input.status === 'READY') {
    return 'Workspace is marked ready, but its worktree is missing.';
  }

  return input.initErrorMessage || 'Workspace setup failed while creating the worktree.';
}

function hasUsableWorktreePath(worktreePath: string | null | undefined): boolean {
  return typeof worktreePath === 'string' && worktreePath.trim().length > 0;
}
