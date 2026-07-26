import type { ServerWorkspace } from './use-workspace-list-state';

export interface SidebarWorkspaceGroups {
  waiting: ServerWorkspace[];
  working: ServerWorkspace[];
  done: ServerWorkspace[];
}

function getCreatedAtMs(value: string | Date): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function byNewest(a: ServerWorkspace, b: ServerWorkspace): number {
  return getCreatedAtMs(b.createdAt) - getCreatedAtMs(a.createdAt);
}

export function groupWorkspacesForSidebar(workspaces: ServerWorkspace[]): SidebarWorkspaceGroups {
  return {
    waiting: workspaces.filter((workspace) => workspace.kanbanColumn === 'WAITING').sort(byNewest),
    working: workspaces.filter((workspace) => workspace.kanbanColumn === 'WORKING').sort(byNewest),
    done: workspaces.filter((workspace) => workspace.kanbanColumn === 'DONE').sort(byNewest),
  };
}
