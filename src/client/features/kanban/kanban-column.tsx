import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { KanbanColumn as KanbanColumnType } from '@/shared/core';
import type { WaitingSortOrder } from './board-view';
import { KanbanCard, type WorkspaceWithKanban } from './kanban-card';
import { WaitingSortMenu } from './waiting-sort-menu';

// UI column IDs include ISSUES (UI-only) plus the database enum values
export type UIKanbanColumnId = 'ISSUES' | KanbanColumnType;

export interface ColumnConfig {
  id: UIKanbanColumnId;
  label: string;
  /** Shorter label used in mobile section navigation */
  shortLabel?: string;
  description: string;
}

export function getKanbanColumns(issueProvider: string): ColumnConfig[] {
  return [
    {
      id: 'ISSUES',
      label: issueProvider === 'LINEAR' ? 'Todo · My Linear Issues' : 'Todo · My GitHub Issues',
      shortLabel: 'Todo',
      description: 'Issues assigned to you',
    },
    { id: 'WORKING', label: 'Working', description: 'Agent is working' },
    { id: 'WAITING', label: 'Waiting', description: 'Waiting for input' },
    { id: 'DONE', label: 'Done', description: 'PR merged or closed' },
  ];
}

interface KanbanColumnProps {
  column: ColumnConfig;
  workspaces: WorkspaceWithKanban[];
  projectSlug: string;
  waitingSortOrder?: WaitingSortOrder;
  onWaitingSortOrderChange?: (order: WaitingSortOrder) => void;
  unreadMailCounts?: Record<string, number>;
  onToggleRatcheting?: (workspaceId: string, enabled: boolean) => void;
  togglingWorkspaceIds?: readonly string[];
  onArchive?: (workspaceId: string) => void;
  onBulkArchive?: () => void;
  isBulkArchiving?: boolean;
  onOpenQuickChat?: (workspaceId: string) => void;
  onRename?: (workspaceId: string, name: string) => Promise<void>;
}

export function KanbanColumn({
  column,
  workspaces,
  projectSlug,
  waitingSortOrder,
  onWaitingSortOrderChange,
  unreadMailCounts,
  onToggleRatcheting,
  togglingWorkspaceIds,
  onArchive,
  onBulkArchive,
  isBulkArchiving,
  onOpenQuickChat,
  onRename,
}: KanbanColumnProps) {
  const showSortMenu = column.id === 'WAITING' && waitingSortOrder && onWaitingSortOrderChange;
  const isEmpty = workspaces.length === 0;
  const showBulkArchiveButton = column.id === 'DONE' && !isEmpty;

  return (
    <div className="flex flex-col w-full md:flex-1 md:min-w-[280px] md:max-w-[440px] md:h-full">
      {/* Section headings remain visible in the stacked mobile list. */}
      <div className="flex h-13 shrink-0 items-center justify-between px-3 py-3 bg-muted/50 rounded-t-lg">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{column.label}</h3>
          <Badge variant="secondary" size="count">
            {workspaces.length}
          </Badge>
        </div>
        {showSortMenu && (
          <WaitingSortMenu value={waitingSortOrder} onChange={onWaitingSortOrderChange} />
        )}
        {showBulkArchiveButton && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onBulkArchive}
                pending={isBulkArchiving}
                className="h-7 px-2"
              >
                <ArchiveIcon className="h-4 w-4" />
                <span className="ml-1 text-xs">Archive All</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Archive all workspaces in this column</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Column Content */}
      <div className="flex flex-col gap-3 flex-1 md:overflow-y-auto p-3 min-h-0 rounded-b-lg bg-muted/50">
        {isEmpty ? (
          <div className="flex items-center justify-center h-[60px] md:h-[150px] text-muted-foreground text-sm">
            {column.description}
          </div>
        ) : (
          workspaces.map((workspace) => (
            <div key={workspace.id} className="shrink-0 space-y-1">
              <KanbanCard
                workspace={workspace}
                projectSlug={projectSlug}
                unreadCount={unreadMailCounts?.[workspace.id]}
                onToggleRatcheting={onToggleRatcheting}
                isTogglePending={togglingWorkspaceIds?.includes(workspace.id) ?? false}
                onArchive={onArchive}
                onOpenQuickChat={onOpenQuickChat}
                onRename={onRename}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
