import { Badge } from '@/components/ui/badge';
import type { KanbanColumn as KanbanColumnType } from '@/shared/core';
import { KanbanCard, type WorkspaceWithKanban } from './kanban-card';

// UI column IDs include ISSUES (UI-only) plus the database enum values
export type UIKanbanColumnId = 'ISSUES' | KanbanColumnType;

export interface ColumnConfig {
  id: UIKanbanColumnId;
  label: string;
  /** Shorter label used in mobile column pills */
  shortLabel?: string;
  description: string;
  /** Tailwind classes for the column header background */
  headerClass: string;
  /** Tailwind classes for the column body background */
  bodyClass: string;
  /** Tailwind classes for mobile pill when active */
  pillActiveClass: string;
}

export const KANBAN_COLUMNS: ColumnConfig[] = [
  {
    id: 'ISSUES',
    label: 'Todo · GitHub',
    description: 'Issues assigned to you',
    headerClass: 'bg-blue-500/10',
    bodyClass: 'bg-blue-500/5',
    pillActiveClass: 'bg-blue-600 text-white dark:bg-blue-500 dark:text-white',
  },
  {
    id: 'WORKING',
    label: 'Working',
    description: 'Agent is working',
    headerClass: 'bg-violet-500/10',
    bodyClass: 'bg-violet-500/5',
    pillActiveClass: 'bg-violet-600 text-white dark:bg-violet-500 dark:text-white',
  },
  {
    id: 'WAITING',
    label: 'Waiting',
    description: 'Waiting for input',
    headerClass: 'bg-amber-500/10',
    bodyClass: 'bg-amber-500/5',
    pillActiveClass: 'bg-amber-600 text-white dark:bg-amber-500 dark:text-white',
  },
  {
    id: 'DONE',
    label: 'Done',
    description: 'PR merged',
    headerClass: 'bg-green-500/10',
    bodyClass: 'bg-green-500/5',
    pillActiveClass: 'bg-green-600 text-white dark:bg-green-500 dark:text-white',
  },
];

export function getKanbanColumns(issueProvider: string): ColumnConfig[] {
  return [
    {
      id: 'ISSUES',
      label: issueProvider === 'LINEAR' ? 'Todo · Linear' : 'Todo · GitHub',
      shortLabel: 'Todo',
      description: 'Issues assigned to you',
      headerClass: 'bg-blue-500/10',
      bodyClass: 'bg-blue-500/5',
      pillActiveClass: 'bg-blue-600 text-white dark:bg-blue-500 dark:text-white',
    },
    KANBAN_COLUMNS[1],
    KANBAN_COLUMNS[2],
    KANBAN_COLUMNS[3],
  ] as ColumnConfig[];
}

interface KanbanColumnProps {
  column: ColumnConfig;
  workspaces: WorkspaceWithKanban[];
  projectSlug: string;
  onToggleRatcheting?: (workspaceId: string, enabled: boolean) => void;
  togglingWorkspaceId?: string | null;
  onArchive?: (workspaceId: string, commitUncommitted: boolean) => void;
  archivingWorkspaceId?: string | null;
}

export function KanbanColumn({
  column,
  workspaces,
  projectSlug,
  onToggleRatcheting,
  togglingWorkspaceId,
  onArchive,
  archivingWorkspaceId,
}: KanbanColumnProps) {
  const isEmpty = workspaces.length === 0;

  return (
    <div className="flex flex-col w-full md:flex-1 md:min-w-[280px] md:max-w-[440px] md:h-full">
      {/* Column Header — hidden on mobile where pills handle this */}
      <div
        className={`hidden md:flex items-center justify-between px-2 py-3 rounded-t-lg ${column.headerClass}`}
      >
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{column.label}</h3>
          <Badge variant="secondary" className="h-5 min-w-5 justify-center text-xs">
            {workspaces.length}
          </Badge>
        </div>
      </div>

      {/* Column Content */}
      <div
        className={`flex flex-col gap-3 flex-1 overflow-y-auto p-3 min-h-0 rounded-lg md:rounded-t-none ${column.bodyClass}`}
      >
        {isEmpty ? (
          <div className="flex items-center justify-center h-[60px] md:h-[150px] text-muted-foreground text-sm">
            {column.description}
          </div>
        ) : (
          workspaces.map((workspace) => (
            <div key={workspace.id} className="shrink-0">
              <KanbanCard
                workspace={workspace}
                projectSlug={projectSlug}
                onToggleRatcheting={onToggleRatcheting}
                isTogglePending={togglingWorkspaceId === workspace.id}
                onArchive={onArchive}
                isArchivePending={archivingWorkspaceId === workspace.id}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
