export type DispatchGateResult =
  | { policy: 'allowed' }
  | { policy: 'manual_resume' }
  | { policy: 'blocked'; permanent: boolean; reason: string | null };

export function getPermanentBlockedDispatchReason(workspace: {
  status?: string | null;
  worktreePath?: string | null;
}): string | null {
  if (workspace.status === 'ARCHIVING' || workspace.status === 'ARCHIVED') {
    return 'Workspace is archived or archiving and cannot accept new messages.';
  }

  if (workspace.status === 'FAILED' && !workspace.worktreePath?.trim()) {
    return 'Workspace setup failed before worktree creation. Retry setup before sending messages.';
  }

  return null;
}
