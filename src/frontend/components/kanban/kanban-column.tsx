import type { KanbanColumn as KanbanColumnType } from '@prisma-gen/browser';
import { Badge } from '@/components/ui/badge';
import { KanbanCard, type WorkspaceWithKanban } from './kanban-card';

// UI column IDs include ISSUES (UI-only) plus the database enum values
export type UIKanbanColumnId = 'ISSUES' | KanbanColumnType;

export interface ColumnConfig {
  id: UIKanbanColumnId;
  label: string;
  description: string;
}

export const KANBAN_COLUMNS: ColumnConfig[] = [
  { id: 'ISSUES', label: 'Issues', description: 'GitHub issues to work on' },
  { id: 'WORKING', label: 'Working', description: 'Agent is working' },
  { id: 'WAITING', label: 'Waiting', description: 'Waiting for input' },
  { id: 'DONE', label: 'Done', description: 'PR merged' },
];

interface KanbanColumnProps {
  column: ColumnConfig;
  workspaces: WorkspaceWithKanban[];
  projectSlug: string;
  isHidden?: boolean;
}

export function KanbanColumn({ column, workspaces, projectSlug, isHidden }: KanbanColumnProps) {
  if (isHidden) {
    return null;
  }

  const isEmpty = workspaces.length === 0;

  return (
    <div className="flex flex-col h-full w-[280px] shrink-0 overflow-hidden">
      {/* Column Header */}
      <div className="flex items-center justify-between px-2 py-3 bg-muted/30 rounded-t-lg">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{column.label}</h3>
          <Badge variant="secondary" className="h-5 min-w-5 justify-center text-xs">
            {workspaces.length}
          </Badge>
        </div>
      </div>

      {/* Column Content */}
      <div className="flex flex-col gap-2 flex-1 overflow-y-auto p-2 min-h-0 rounded-b-lg bg-muted/30">
        {isEmpty ? (
          <div className="flex items-center justify-center h-[150px] text-muted-foreground text-sm">
            {column.description}
          </div>
        ) : (
          workspaces.map((workspace) => (
            <KanbanCard key={workspace.id} workspace={workspace} projectSlug={projectSlug} />
          ))
        )}
      </div>
    </div>
  );
}
