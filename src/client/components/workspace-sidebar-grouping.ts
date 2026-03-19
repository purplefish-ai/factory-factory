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
    waiting: workspaces
      .filter((workspace) => workspace.cachedKanbanColumn === 'WAITING')
      .sort(byNewest),
    working: workspaces
      .filter((workspace) => workspace.cachedKanbanColumn === 'WORKING')
      .sort(byNewest),
    done: workspaces.filter((workspace) => workspace.cachedKanbanColumn === 'DONE').sort(byNewest),
  };
}

export interface AllProjectsSidebarGroups {
  projects: Array<{
    project: { id: string; slug: string; name: string };
    waiting: ServerWorkspace[];
    working: ServerWorkspace[];
    done: ServerWorkspace[];
  }>;
}

export function groupWorkspacesForAllProjects(
  allProjectsData: Array<{
    project: { id: string; slug: string; name: string };
    workspaces: ServerWorkspace[];
  }>
): AllProjectsSidebarGroups {
  return {
    projects: allProjectsData.map(({ project, workspaces }) => ({
      project,
      ...groupWorkspacesForSidebar(workspaces),
    })),
  };
}
