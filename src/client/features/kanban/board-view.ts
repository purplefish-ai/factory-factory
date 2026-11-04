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

export type WaitingSortOrder = 'latest-message' | 'created';

export function sortBoardWorkspaces(
  rows: WorkspaceWithKanban[],
  waitingSortOrder: WaitingSortOrder = 'latest-message'
) {
  return [...rows].sort((a, b) => {
    const createdDifference = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (
      waitingSortOrder === 'latest-message' &&
      a.kanbanColumn === 'WAITING' &&
      b.kanbanColumn === 'WAITING'
    ) {
      const timestamp = (row: WorkspaceWithKanban) => {
        const activity = row.lastActivityAt ? Date.parse(row.lastActivityAt) : Number.NaN;
        return Number.isFinite(activity) ? activity : new Date(row.createdAt).getTime();
      };
      return timestamp(b) - timestamp(a) || createdDifference;
    }
    return createdDifference;
  });
}
