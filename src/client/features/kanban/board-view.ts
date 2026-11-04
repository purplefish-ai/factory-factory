import type { WorkspaceWithKanban } from './kanban-card';

export function filterBoardWorkspaces(rows: WorkspaceWithKanban[], search: string) {
  const query = search.trim().toLocaleLowerCase();
  if (!query) {
    return rows;
  }
  return rows.filter((row) =>
    [row.name, row.branchName, row.conversationSummary?.summary].some((value) =>
      value?.toLocaleLowerCase().includes(query)
    )
  );
}

export function sortBoardWorkspaces(rows: WorkspaceWithKanban[]) {
  return [...rows].sort((a, b) => {
    if (a.kanbanColumn === 'WAITING' && b.kanbanColumn === 'WAITING') {
      const timestamp = (value: string | null | undefined) =>
        value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number.POSITIVE_INFINITY;
      const difference = timestamp(a.waitingSince) - timestamp(b.waitingSince);
      if (difference !== 0 && !Number.isNaN(difference)) {
        return difference;
      }
    }
    const difference = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return -difference;
  });
}
