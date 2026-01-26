'use client';

import type { KanbanColumn as KanbanColumnType } from '@prisma-gen/browser';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { KanbanCard, type WorkspaceWithKanban } from './kanban-card';

interface ColumnConfig {
  id: KanbanColumnType;
  label: string;
  description: string;
}

export const KANBAN_COLUMNS: ColumnConfig[] = [
  { id: 'BACKLOG', label: 'Backlog', description: 'Not started yet' },
  { id: 'IN_PROGRESS', label: 'In Progress', description: 'Actively working' },
  { id: 'WAITING', label: 'Waiting', description: 'Idle, needs attention' },
  { id: 'PR_OPEN', label: 'PR Open', description: 'Under review' },
  { id: 'APPROVED', label: 'Approved', description: 'Ready to merge' },
  { id: 'MERGED', label: 'Merged', description: 'PR merged' },
  { id: 'DONE', label: 'Done', description: 'Completed' },
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
    <div className="flex flex-col h-full min-w-[280px] max-w-[320px]">
      {/* Column Header */}
      <div className="flex items-center justify-between px-2 py-3 border-b bg-muted/30 rounded-t-lg">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{column.label}</h3>
          <Badge variant="secondary" className="h-5 min-w-5 justify-center text-xs">
            {workspaces.length}
          </Badge>
        </div>
      </div>

      {/* Column Content */}
      <ScrollArea className="flex-1">
        <div
          className={cn(
            'p-2 space-y-2 min-h-[200px] rounded-b-lg border border-t-0',
            isEmpty && 'border-dashed'
          )}
        >
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
      </ScrollArea>
    </div>
  );
}
