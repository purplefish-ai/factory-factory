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

function getLastActivityMs(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function makeComparator(unreadIds: Set<string>) {
  return function compare(a: ServerWorkspace, b: ServerWorkspace): number {
    const aUnread = unreadIds.has(a.id) ? 1 : 0;
    const bUnread = unreadIds.has(b.id) ? 1 : 0;
    if (bUnread !== aUnread) {
      return bUnread - aUnread;
    }

    const activityDiff = getLastActivityMs(b.lastActivityAt) - getLastActivityMs(a.lastActivityAt);
    if (activityDiff !== 0) {
      return activityDiff;
    }

    return getCreatedAtMs(b.createdAt) - getCreatedAtMs(a.createdAt);
  };
}

export function groupWorkspacesForSidebar(
  workspaces: ServerWorkspace[],
  unreadIds: Set<string> = new Set()
): SidebarWorkspaceGroups {
  const compare = makeComparator(unreadIds);
  return {
    waiting: workspaces
      .filter((workspace) => workspace.cachedKanbanColumn === 'WAITING')
      .sort(compare),
    working: workspaces
      .filter((workspace) => workspace.cachedKanbanColumn === 'WORKING')
      .sort(compare),
    done: workspaces.filter((workspace) => workspace.cachedKanbanColumn === 'DONE').sort(compare),
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
  }>,
  unreadIds: Set<string> = new Set()
): AllProjectsSidebarGroups {
  return {
    projects: allProjectsData.map(({ project, workspaces }) => ({
      project,
      ...groupWorkspacesForSidebar(workspaces, unreadIds),
    })),
  };
}
