import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import type { WorkspaceHeaderWorkspace, WorkspaceSwitchGroups } from './types';

export function getCreatedAtMs(value: string | Date): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function byNewest(a: ServerWorkspace, b: ServerWorkspace): number {
  return getCreatedAtMs(b.createdAt) - getCreatedAtMs(a.createdAt);
}

export function groupWorkspaceSwitcherItems(workspaces: ServerWorkspace[]): WorkspaceSwitchGroups {
  const todo = workspaces
    .filter(
      (workspace) => workspace.cachedKanbanColumn === 'WAITING' && !workspace.pendingRequestType
    )
    .sort(byNewest);
  const waiting = workspaces
    .filter(
      (workspace) => workspace.cachedKanbanColumn === 'WAITING' && workspace.pendingRequestType
    )
    .sort(byNewest);
  const working = workspaces
    .filter((workspace) => workspace.cachedKanbanColumn === 'WORKING')
    .sort(byNewest);
  const done = workspaces
    .filter((workspace) => workspace.cachedKanbanColumn === 'DONE')
    .sort(byNewest);

  return { todo, waiting, working, done };
}

export function getWorkspaceHeaderLabel(
  branchName: string | null | undefined,
  workspaceName: string,
  isMobile: boolean
): string {
  if (!branchName) {
    return workspaceName;
  }

  if (!isMobile) {
    return branchName;
  }

  const slashIndex = branchName.indexOf('/');
  if (slashIndex === -1 || slashIndex === branchName.length - 1) {
    return branchName;
  }

  return branchName.slice(slashIndex + 1);
}

export function isWorkspaceMerged(
  workspace: Pick<WorkspaceHeaderWorkspace, 'prState' | 'ratchetState' | 'sidebarStatus'>
): boolean {
  return (
    workspace.prState === 'MERGED' ||
    workspace.ratchetState === 'MERGED' ||
    workspace.sidebarStatus?.ciState === 'MERGED'
  );
}

export function hasVisiblePullRequest(
  workspace: Pick<WorkspaceHeaderWorkspace, 'prUrl' | 'prNumber' | 'prState'>
): workspace is {
  prUrl: NonNullable<WorkspaceHeaderWorkspace['prUrl']>;
  prNumber: NonNullable<WorkspaceHeaderWorkspace['prNumber']>;
  prState: WorkspaceHeaderWorkspace['prState'];
} {
  return Boolean(
    workspace.prUrl &&
      workspace.prNumber &&
      workspace.prState !== 'NONE' &&
      workspace.prState !== 'CLOSED'
  );
}
