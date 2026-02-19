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
}

export const KANBAN_COLUMNS: ColumnConfig[] = [
  { id: 'ISSUES', label: 'Todo · GitHub', description: 'Issues assigned to you' },
  { id: 'WORKING', label: 'Working', description: 'Agent is working' },
  { id: 'WAITING', label: 'Waiting', description: 'Waiting for input' },
  { id: 'DONE', label: 'Done', description: 'PR merged' },
];

export function getKanbanColumns(issueProvider: string): ColumnConfig[] {
  return [
    {
      id: 'ISSUES',
      label: issueProvider === 'LINEAR' ? 'Todo · Linear' : 'Todo · GitHub',
      shortLabel: 'Todo',
      description: 'Issues assigned to you',
    },
    { id: 'WORKING', label: 'Working', description: 'Agent is working' },
    { id: 'WAITING', label: 'Waiting', description: 'Waiting for input' },
    { id: 'DONE', label: 'Done', description: 'PR merged' },
  ];
}

interface KanbanColumnProps {
  column: ColumnConfig;
  workspaces: WorkspaceWithKanban[];
  projectSlug: string;
  onToggleRatcheting?: (workspaceId: string, enabled: boolean) => void;
  togglingWorkspaceId?: string | null;
  onArchive?: (workspaceId: string, commitUncommitted: boolean) => void;
  archivingWorkspaceId?: string | null;
  onCreatePr?: (workspaceId: string) => void;
  creatingPrWorkspaceId?: string | null;
}

export function KanbanColumn({
  column,
  workspaces,
  projectSlug,
  onToggleRatcheting,
  togglingWorkspaceId,
  onArchive,
  archivingWorkspaceId,
  onCreatePr,
  creatingPrWorkspaceId,
}: KanbanColumnProps) {
  const isEmpty = workspaces.length === 0;

  return (
    <div className="flex flex-col w-full md:flex-1 md:min-w-[280px] md:max-w-[440px] md:h-full">
      {/* Column Header — hidden on mobile where pills handle this */}
      <div className="hidden md:flex items-center justify-between px-2 py-3 bg-muted/30 rounded-t-lg">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{column.label}</h3>
          <Badge variant="secondary" className="h-5 min-w-5 justify-center text-xs">
            {workspaces.length}
          </Badge>
        </div>
      </div>

      {/* Column Content */}
      <div className="flex flex-col gap-3 flex-1 overflow-y-auto p-3 min-h-0 rounded-lg md:rounded-t-none bg-muted/30">
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
                onCreatePr={onCreatePr}
                isCreatingPr={creatingPrWorkspaceId === workspace.id}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
