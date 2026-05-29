import type { WorkspaceStatusReason } from '@/shared/workspace-status-reason';

const HIDDEN_WORKSPACE_STATUS_REASON_CODES = new Set<WorkspaceStatusReason['code']>([
  'SETTING_UP',
  'NO_SESSION_STARTED',
  'READY_FOR_NEXT_PROMPT',
]);

export function shouldShowWorkspaceStatusReason(
  statusReason: WorkspaceStatusReason | null | undefined
): statusReason is WorkspaceStatusReason {
  return Boolean(statusReason && !HIDDEN_WORKSPACE_STATUS_REASON_CODES.has(statusReason.code));
}

export function getVisibleWorkspaceStatusReason(
  statusReason: WorkspaceStatusReason | null | undefined
): WorkspaceStatusReason | null {
  return shouldShowWorkspaceStatusReason(statusReason) ? statusReason : null;
}
